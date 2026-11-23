'use strict';
// R7: confirm-then-ack republish, SIGKILL safety.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { RabbitMQClient } = require('../../dist/cjs');
const { startBroker } = require('../helpers/broker');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
let broker;
const clients = [];

function makeClient(config) {
  const client = new RabbitMQClient({ stopAutoInit: true, logger: silent, retryDelay: 100, connection_url: broker.url(), topology: 'none', ...config });
  clients.push(client);
  return client;
}

test.before(async () => {
  broker = await startBroker();
  await broker.admin(async (channel) => {
    await channel.assertQueue('work.q', { durable: true });
    // retry tier: TTL queue that dead-letters back to the work queue (owned by the consumer, not the library)
    await channel.assertExchange('retry.ex', 'direct', { durable: true });
    await channel.assertQueue('work.q.retry.1s', {
      durable: true,
      arguments: { 'x-message-ttl': 1000, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'work.q' },
    });
    await channel.bindQueue('work.q.retry.1s', 'retry.ex', 'work.q.retry.1s');
    await channel.assertExchange('dlx.topic', 'topic', { durable: true });
    await channel.assertQueue('work.q.dlq', { durable: true });
    await channel.bindQueue('work.q.dlq', 'dlx.topic', 'work.q.#');
    await channel.assertQueue('kill.q', { durable: true });
  });
});

test.after(async () => {
  await Promise.all(clients.map((client) => client.close({ drainTimeoutMs: 0 }).catch(() => {})));
  await broker?.stop();
});

test('R7: republish through a broker TTL retry queue acks the original strictly after the copy is confirmed', async () => {
  const client = makeClient({ prefetch: 1 });
  await client.init();
  const order = [];
  const publishChannel = client.getPublishChannel();
  publishChannel.on('ack', () => order.push('broker-confirm'));
  const consumeChannel = client.getChannel();
  const originalAck = consumeChannel.ack.bind(consumeChannel);
  consumeChannel.ack = (message, allUpTo) => {
    order.push('ack-original');
    return originalAck(message, allUpTo);
  };

  const attempts = [];
  client.onQueue('work.q').handleAll(async (event) => {
    const count = Number(event.message.properties.headers?.['x-retry-count'] ?? 0);
    attempts.push({ count, at: Date.now() });
    if (count < 1) {
      await event.republish({ exchange: 'retry.ex', routingKey: 'work.q.retry.1s', headers: { 'x-retry-count': count + 1 } });
    }
    else {
      await event.republish({ exchange: 'dlx.topic', routingKey: 'work.q.failed', headers: { 'x-error': 'gave up' } });
    }
  });

  await client.sendMessage({ queue: 'work.q', data: 'job-1', publishOptions: { persistent: true, messageId: 'job-1' } });
  await broker.waitFor(async () => (await broker.queue('work.q.dlq'))?.messages === 1, { message: 'message dead-lettered' });

  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].at - attempts[0].at >= 900, 'the delay came from the broker TTL queue');
  // sendMessage confirm, then (copy confirm -> ack) twice
  assert.deepEqual(order, ['broker-confirm', 'broker-confirm', 'ack-original', 'broker-confirm', 'ack-original']);

  const dead = await client.getChannel().get('work.q.dlq', { noAck: true });
  assert.equal(String(dead.content), 'job-1');
  assert.equal(dead.properties.headers['x-retry-count'], 1);
  assert.equal(dead.properties.headers['x-error'], 'gave up');
  assert.equal(dead.properties.messageId, 'job-1');
  await client.close();
});

test('R7: an unroutable republish nack-requeues the original (mandatory by default)', async () => {
  const client = makeClient({ prefetch: 1 });
  await client.init();
  const outcomes = [];
  const subscription = client.onQueue('work.q').handleAll(async (event) => {
    if (event.message.fields.redelivered) {
      outcomes.push('redelivered');
      event.ack();
      return;
    }
    try {
      await event.republish({ exchange: 'retry.ex', routingKey: 'no.such.binding' });
    }
    catch (error) {
      outcomes.push(error.name);
    }
  });
  await client.sendMessage({ queue: 'work.q', data: 'job-2', publishOptions: { persistent: true } });
  await broker.waitFor(() => outcomes.length === 2, { message: 'redelivery after failed republish' });
  assert.deepEqual(outcomes, ['PublishReturnedError', 'redelivered']);
  subscription.unsubscribe();
  await client.close();
});

test('R7: a consumer SIGKILLed between receive and republish loses nothing (message is redelivered)', async () => {
  const publisher = makeClient({});
  await publisher.init();
  await publisher.sendMessage({ queue: 'kill.q', data: 'precious', publishOptions: { persistent: true } });

  const child = fork(path.join(__dirname, 'fixtures/consumer-child.js'), [broker.url(), 'kill.q', 'before-republish'], { stdio: 'inherit' });
  const [message] = await new Promise((resolve, reject) => {
    child.on('message', (msg) => { if (msg.type === 'received') resolve([msg]); });
    child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
  });
  assert.equal(message.body, 'precious');
  assert.equal(message.redelivered, false);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');

  const redelivered = await new Promise((resolve) => {
    publisher.forQueue('kill.q').subscribe((event) => { event.ack(); resolve(event); });
  });
  assert.equal(String(redelivered.data), 'precious');
  assert.equal(redelivered.message.fields.redelivered, true);
  await publisher.close();
});
