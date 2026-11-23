'use strict';
// R4 (stable subscriptions across reconnects), R6 (channel-level resilience), R5 (graceful shutdown).
const test = require('node:test');
const assert = require('node:assert/strict');
const { firstValueFrom, filter } = require('rxjs');
const { RabbitMQClient } = require('../../dist/cjs');
const { startBroker } = require('../helpers/broker');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let broker;
const clients = [];

function makeClient(name, config) {
  const client = new RabbitMQClient({
    stopAutoInit: true,
    logger: silent,
    retryDelay: 100,
    maxRetryDelay: 1000,
    metrics: true,
    connection_url: broker.url(),
    socketOptions: { clientProperties: { connection_name: name } },
    exchanges: [],
    bindings: [],
    ...config,
  });
  clients.push(client);
  return client;
}

const until = (client, state) => firstValueFrom(client.state$.pipe(filter((value) => value === state)));

test.before(async () => {
  broker = await startBroker();
});

test.after(async () => {
  await Promise.all(clients.map((client) => client.close({ drainTimeoutMs: 0 }).catch(() => {})));
  await broker?.stop();
});

test('R4: the same subscription keeps receiving after the connection is killed via the management API', async () => {
  const client = makeClient('r4-reconnect', { queues: [{ name: 'r4.q', options: { durable: true } }] });
  await client.init();

  const received = [];
  const subscription = client.onQueue('r4.q').handle('PING').subscribe((event) => {
    received.push(String(event.data));
    event.ack();
  });

  await client.sendMessage({ queue: 'r4.q', data: 'before', publishOptions: { type: 'PING' } });
  await broker.waitFor(() => received.includes('before'), { message: 'delivery before reconnect' });

  const states = [];
  client.state$.subscribe((state) => states.push(state));
  const killed = await broker.killConnections('r4-reconnect');
  assert.equal(killed, 1);
  await until(client, 'reconnecting');
  await until(client, 'ready');

  await client.sendMessage({ queue: 'r4.q', data: 'after', publishOptions: { type: 'PING' } });
  await broker.waitFor(() => received.includes('after'), { message: 'delivery after reconnect' });
  assert.deepEqual(received, ['before', 'after']);
  assert.ok(states.includes('reconnecting'));
  assert.ok(client.getMetrics().reconnects >= 1);
  assert.equal(subscription.closed, false);

  const queue = await broker.waitFor(async () => {
    const info = await broker.queue('r4.q');
    return info && info.consumers === 1 ? info : null;
  }, { message: 'exactly one consumer after reconnect' });
  assert.equal(queue.consumers, 1);
  subscription.unsubscribe();
  await client.close();
});

test('R6: a forced 406 (double ack) recovers the channel and consumption resumes', async () => {
  const client = makeClient('r6-406', { queues: [{ name: 'r6.q', options: { durable: true } }] });
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event));
  await client.init();

  const received = [];
  client.forQueue('r6.q').subscribe((event) => {
    received.push(event);
    if (String(event.data) === 'poison') {
      const channel = client.getChannel();
      channel.ack(event.message); // raw channel access bypasses the library's at-most-once guard
      channel.ack(event.message);
    }
    else {
      event.ack();
    }
  });

  await client.sendMessage({ queue: 'r6.q', data: 'poison', publishOptions: {} });
  await broker.waitFor(() => errors.some((event) => event.type === 'channel-error' && event.error.code === 406), { message: '406 channel error' });
  assert.notEqual(client.state, 'ready');
  await until(client, 'ready');

  await client.sendMessage({ queue: 'r6.q', data: 'after', publishOptions: {} });
  await broker.waitFor(() => received.some((event) => String(event.data) === 'after'), { message: 'delivery after 406' });
  assert.ok(client.getMetrics().channelRecreated >= 1);
  await client.close();
});

test('R6: deleting a consumed queue emits consumer-cancelled; declare mode re-creates it and resumes', async () => {
  const client = makeClient('r6-cancel', { queues: [{ name: 'r6.cancel.q', options: { durable: true } }] });
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event));
  await client.init();

  const received = [];
  client.forQueue('r6.cancel.q').subscribe((event) => { received.push(String(event.data)); event.ack(); });
  await broker.waitFor(async () => (await broker.queue('r6.cancel.q'))?.consumers === 1, { message: 'consumer registered' });

  await broker.deleteQueue('r6.cancel.q');
  await broker.waitFor(() => errors.some((event) => event.type === 'consumer-cancelled' && event.queue === 'r6.cancel.q'), { message: 'consumer-cancelled event' });
  await until(client, 'ready');

  await client.sendMessage({ queue: 'r6.cancel.q', data: 'resumed', publishOptions: {} });
  await broker.waitFor(() => received.includes('resumed'), { message: 'delivery after queue re-creation' });
  await client.close();
});

test('R5: close() stops consuming, drains in-flight handlers, never reconnects, and leaves no consumers or connections', async () => {
  const client = makeClient('r5-close', { queues: [{ name: 'r5.q', options: { durable: true } }], prefetch: 5 });
  await client.init();

  let started = 0;
  let finished = 0;
  client.onQueue('r5.q').handleAll(async (event) => {
    started += 1;
    await sleep(500);
    finished += 1;
    event.ack();
  });
  await client.sendMessage({ queue: 'r5.q', data: 'slow', publishOptions: {} });
  await broker.waitFor(() => started === 1, { message: 'handler start' });

  const closed = client.close({ drainTimeoutMs: 5000 });
  assert.equal(client.state, 'closing');
  await closed;
  assert.equal(finished, 1, 'in-flight handler finished before close resolved');
  assert.equal(client.state, 'closed');

  await sleep(10000);
  assert.equal(client.state, 'closed');
  assert.deepEqual(await broker.connectionsNamed('r5-close'), [], 'no connection from the client');
  const queue = await broker.waitFor(async () => {
    const info = await broker.queue('r5.q');
    return info && info.consumers === 0 && info.messages === 0 ? info : null;
  }, { message: 'zero consumers and the message acked' });
  assert.equal(queue.consumers, 0);
  assert.equal(queue.messages_unacknowledged, 0);
});
