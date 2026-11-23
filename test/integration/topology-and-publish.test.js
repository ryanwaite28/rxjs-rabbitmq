'use strict';
// R1 (topology modes under a least-privilege user) and R2 (confirmed publishing).
const test = require('node:test');
const assert = require('node:assert/strict');
const { firstValueFrom, filter, take, toArray } = require('rxjs');
const {
  RabbitMQClient,
  PublishChannelClosedError,
  PublishNackedError,
  PublishReturnedError,
  TopologyVerificationError,
} = require('../../dist/cjs');
const { startBroker } = require('../helpers/broker');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
let broker;
const clients = [];

function makeClient(config) {
  const client = new RabbitMQClient({ stopAutoInit: true, logger: silent, retryDelay: 100, metrics: true, ...config });
  clients.push(client);
  return client;
}

test.before(async () => {
  broker = await startBroker();
  await broker.admin(async (channel) => {
    await channel.assertExchange('app.ex', 'topic', { durable: true });
    await channel.assertQueue('app.q', { durable: true });
    await channel.bindQueue('app.q', 'app.ex', 'app.#');
  });
  await broker.createUser('restricted', 'restricted', {
    configure: '^$',
    write: '^app\\.ex$',
    read: '^app\\.q$',
  });
});

test.after(async () => {
  await Promise.all(clients.map((client) => client.close({ drainTimeoutMs: 0 }).catch(() => {})));
  await broker?.stop();
});

test("R1: a user with configure '^$' can init in 'verify' mode, consume app.q and publish to app.ex", async () => {
  const client = makeClient({
    connection_url: broker.url('restricted', 'restricted'),
    topology: 'verify',
    confirm: true,
    prefetch: 10,
    queues: [{ name: 'app.q' }],
    exchanges: [{ name: 'app.ex', type: 'topic' }],
    bindings: [{ queue: 'app.q', exchange: 'app.ex', routingKey: 'app.#' }],
  });
  await client.init();
  assert.equal(client.state, 'ready');

  const received = firstValueFrom(client.onQueue('app.q').handle('CREATED').pipe(take(1)));
  const all = client.onQueue('app.q').handle('CREATED').subscribe((event) => event.ack());
  await client.publishEvent({
    exchange: 'app.ex',
    routingKey: 'app.created',
    data: { id: 1 },
    publishOptions: { type: 'CREATED', contentType: 'application/json', persistent: true, mandatory: true },
  });
  const event = await received;
  assert.deepEqual(event.data, { id: 1 });
  assert.equal(event.queue, 'app.q');
  all.unsubscribe();
  await client.close();
});

test("R1: 'declare' mode under the same user fails with 403 (the 2.x behavior)", async () => {
  const client = makeClient({
    connection_url: broker.url('restricted', 'restricted'),
    topology: 'declare',
    queues: [{ name: 'app.q', options: { durable: true } }],
    exchanges: [],
    bindings: [],
  });
  await assert.rejects(client.init(), /403|ACCESS_REFUSED/);
  assert.equal(client.state, 'idle');
  await client.close();
});

test("R1: 'verify' against a missing queue rejects init with an error naming it", async () => {
  const client = makeClient({
    connection_url: broker.url('restricted', 'restricted'),
    topology: 'verify',
    queues: [{ name: 'app.q' }, { name: 'app.missing' }],
    exchanges: [],
  });
  const error = await client.init().catch((e) => e);
  assert.ok(error instanceof TopologyVerificationError, String(error));
  assert.equal(error.resource, 'app.missing');
  assert.match(error.message, /queue "app\.missing"/);
  await client.close();
});

test("R1: 'verify' against a missing exchange names the exchange", async () => {
  const client = makeClient({
    connection_url: broker.url('restricted', 'restricted'),
    topology: 'verify',
    queues: [{ name: 'app.q' }],
    exchanges: [{ name: 'app.missing.ex', type: 'topic' }],
  });
  const error = await client.init().catch((e) => e);
  assert.ok(error instanceof TopologyVerificationError, String(error));
  assert.equal(error.resourceType, 'exchange');
  assert.equal(error.resource, 'app.missing.ex');
  await client.close();
});

test('R2: 1,000 concurrent confirmed publishes all resolve after broker acks', async () => {
  const client = makeClient({
    connection_url: broker.url(),
    queues: [{ name: 'confirm.q', options: { durable: true } }],
    exchanges: [{ name: 'confirm.ex', type: 'fanout', options: { durable: true } }],
    bindings: [{ queue: 'confirm.q', exchange: 'confirm.ex', routingKey: '' }],
  });
  await client.init();
  const publishes = Array.from({ length: 1000 }, (_, i) => client.publishEvent({
    exchange: 'confirm.ex',
    data: { i },
    publishOptions: { contentType: 'application/json', persistent: true },
  }));
  await Promise.all(publishes);
  assert.equal(client.getMetrics().publishConfirmed, 1000);
  const { messageCount } = await client.getChannel().checkQueue('confirm.q');
  assert.equal(messageCount, 1000);
  await client.close();
});

test('R2: broker nack (reject-publish overflow) rejects with PublishNackedError', async () => {
  const client = makeClient({
    connection_url: broker.url(),
    queues: [{ name: 'nack.q', options: { durable: true, arguments: { 'x-max-length': 1, 'x-overflow': 'reject-publish' } } }],
    exchanges: [{ name: 'nack.ex', type: 'fanout', options: { durable: true } }],
    bindings: [{ queue: 'nack.q', exchange: 'nack.ex', routingKey: '' }],
  });
  await client.init();
  await client.publishEvent({ exchange: 'nack.ex', data: 'first', publishOptions: {} });
  await assert.rejects(client.publishEvent({ exchange: 'nack.ex', data: 'second', publishOptions: {} }), PublishNackedError);
  assert.equal(client.getMetrics().publishNacked, 1);
  assert.equal(client.state, 'ready');
  await client.close();
});

test('R2: an unroutable mandatory publish rejects with PublishReturnedError', async () => {
  const client = makeClient({ connection_url: broker.url(), topology: 'none' });
  await client.init();
  const error = await client.publishEvent({ exchange: 'app.ex', routingKey: 'nowhere.at.all', data: 'x', publishOptions: { mandatory: true } }).catch((e) => e);
  assert.ok(error instanceof PublishReturnedError, String(error));
  assert.equal(error.replyCode, 312);
  assert.equal(error.replyText, 'NO_ROUTE');
  // non-mandatory unroutable publishes are confirmed (and dropped) by the broker, as usual
  await client.publishEvent({ exchange: 'app.ex', routingKey: 'nowhere.at.all', data: 'x', publishOptions: {} });
  await client.close();
});

test('R2/R6: a publish to a nonexistent exchange rejects, the publish channel is recovered, and consumption is not interrupted', async () => {
  const client = makeClient({
    connection_url: broker.url(),
    queues: [{ name: 'recover.q', options: { durable: true } }],
    exchanges: [],
    bindings: [],
  });
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event));
  await client.init();

  const received = [];
  client.forQueue('recover.q').subscribe((event) => { received.push(String(event.data)); event.ack(); });
  await broker.waitFor(async () => (await client.getChannel().checkQueue('recover.q')).consumerCount === 1, { message: 'consumer' });
  const consumeChannel = client.getChannel();

  const error = await client.publishEvent({ exchange: 'does.not.exist', data: 'x', publishOptions: {} }).catch((e) => e);
  assert.ok(error instanceof PublishChannelClosedError, String(error));
  assert.match(error.cause.message, /404/);
  assert.ok(errors.some((event) => event.type === 'channel-error' && event.channel === 'publish'));

  await firstValueFrom(client.state$.pipe(filter((state) => state === 'ready')));
  await client.sendMessage({ queue: 'recover.q', data: 'after-404', publishOptions: {} });
  await broker.waitFor(() => received.includes('after-404'), { message: 'delivery after recovery' });
  assert.equal(client.getChannel(), consumeChannel, 'consume channel was not affected');
  assert.equal(client.getMetrics().channelRecreated, 1);
  await client.close();
});

test('R2: backpressure — publishes wait for drain and all resolve', async () => {
  const debug = [];
  const client = makeClient({
    connection_url: broker.url(),
    logger: { ...silent, debug: (message) => debug.push(String(message)) },
    publishChannelOptions: { highWaterMark: 4 },
    queues: [{ name: 'bp.q', options: { durable: true } }],
    exchanges: [],
    bindings: [],
  });
  await client.init();
  const payload = Buffer.alloc(64 * 1024, 7);
  const publishes = Array.from({ length: 300 }, () => client.sendMessage({
    queue: 'bp.q',
    data: payload,
    publishOptions: { contentType: 'application/octet-stream' },
  }));
  await Promise.all(publishes);
  assert.ok(debug.some((line) => line.includes('waiting for drain')), 'backpressure was hit');
  const { messageCount } = await client.getChannel().checkQueue('bp.q');
  assert.equal(messageCount, 300);
  await client.close();
});

test('R3: a late subscriber receives no historical messages', async () => {
  const client = makeClient({
    connection_url: broker.url(),
    queues: [{ name: 'late.q', options: { durable: true } }],
    exchanges: [],
    bindings: [],
  });
  await client.init();
  const early = client.forQueue('late.q').pipe(take(3), toArray());
  const earlyDone = firstValueFrom(early.pipe((source) => source));
  const subscription = client.forQueue('late.q').subscribe((event) => event.ack());
  for (const n of [1, 2]) await client.sendMessage({ queue: 'late.q', data: `m${n}`, publishOptions: {} });
  await broker.waitFor(async () => (await client.getChannel().checkQueue('late.q')).messageCount === 0, { message: 'consumed' });

  const late = [];
  const lateSubscription = client.forQueue('late.q').subscribe((event) => late.push(String(event.data)));
  await client.sendMessage({ queue: 'late.q', data: 'm3', publishOptions: {} });
  const all = await earlyDone;
  assert.deepEqual(all.map((event) => String(event.data)), ['m1', 'm2', 'm3']);
  assert.deepEqual(late, ['m3']);
  subscription.unsubscribe();
  lateSubscription.unsubscribe();
  await client.close();
});
