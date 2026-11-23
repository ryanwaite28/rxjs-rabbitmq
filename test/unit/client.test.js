'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { firstValueFrom, filter } = require('rxjs');
const {
  RabbitMQClient,
  ClientClosedError,
  ClientNotReadyError,
  PublishChannelClosedError,
  PublishNackedError,
  PublishReturnedError,
  TopologyVerificationError,
  MessageAlreadySettledError,
} = require('../../dist/cjs');
const { createFakeAmqp } = require('../helpers/fake-amqp');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(fake, config = {}) {
  return new RabbitMQClient({
    stopAutoInit: true,
    connection_url: 'amqp://fake',
    connect: fake.connect,
    logger: silent,
    retryDelay: 5,
    maxRetryDelay: 20,
    metrics: true,
    queues: [{ name: 'jobs' }],
    exchanges: [{ name: 'app.ex', type: 'topic' }],
    bindings: [{ queue: 'jobs', exchange: 'app.ex', routingKey: 'jobs.#' }],
    ...config,
  });
}

function waitForState(client, state) {
  return firstValueFrom(client.state$.pipe(filter((value) => value === state)));
}

async function settleUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(2);
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('state machine: idle -> connecting -> ready -> reconnecting -> ready -> closing -> closed', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  const states = [];
  client.state$.subscribe((state) => states.push(state));

  assert.equal(client.state, 'idle');
  await client.init();
  assert.equal(client.state, 'ready');
  assert.equal(client.isReady, true);

  fake.connection.kill();
  assert.equal(client.state, 'reconnecting');
  await waitForState(client, 'ready');

  await client.close();
  assert.equal(client.state, 'closed');
  assert.deepEqual(states, ['idle', 'connecting', 'ready', 'reconnecting', 'ready', 'closing', 'closed']);
});

test('close() never schedules a reconnect', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  await client.close();
  await sleep(100);
  assert.equal(fake.connections.length, 1);
  assert.equal(fake.connection.closed, true);
  assert.equal(client.state, 'closed');
  await assert.rejects(client.init(), ClientClosedError);
});

test('close() during a pending reconnect cancels it', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { retryDelay: 50 });
  await client.init();
  fake.connection.kill();
  assert.equal(client.state, 'reconnecting');
  await client.close();
  await sleep(150);
  assert.equal(fake.connections.length, 1);
  assert.equal(client.state, 'closed');
});

test('init failure without retries rejects and returns to idle', async () => {
  const fake = createFakeAmqp();
  fake.failConnects = 1;
  const client = makeClient(fake);
  await assert.rejects(client.init(), /ECONNREFUSED/);
  assert.equal(client.state, 'idle');
  await client.init();
  assert.equal(client.state, 'ready');
  await client.close();
});

test('init retries up to retryAttempts', async () => {
  const fake = createFakeAmqp();
  fake.failConnects = 2;
  const client = makeClient(fake, { retryAttempts: 2 });
  await client.init();
  assert.equal(fake.connectAttempts, 3);
  await client.close();
});

test('auto-init failure is reported on errors$ instead of an unhandled rejection', async () => {
  const fake = createFakeAmqp();
  fake.failConnects = 1;
  const errors = [];
  const client = makeClient(fake, { stopAutoInit: false });
  client.errors$.subscribe((event) => errors.push(event));
  await settleUntil(() => errors.length > 0);
  assert.equal(errors[0].type, 'init-failed');
  await client.close();
});

test('recovery gives up after retryAttempts consecutive failures and closes', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { retryAttempts: 2 });
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event.type));
  await client.init();
  fake.failConnects = 100;
  fake.connection.kill();
  await waitForState(client, 'closed');
  assert.ok(errors.includes('recovery-exhausted'));
  assert.equal(fake.connectAttempts, 3);
});

test('subscriptions added while init is starting consumers are consumed before ready', async () => {
  const fake = createFakeAmqp();
  fake.consumeDelayMs = 30;
  const client = makeClient(fake, {
    queues: [{ name: 'jobs', handleMessageTypes: [{ messageName: 'A', callbackHandler: (event) => event.ack() }] }],
  });
  const init = client.init();
  await settleUntil(() => fake.log.some((entry) => entry[1] === 'consume'));
  client.forQueue('late.q').subscribe(() => {});
  await init;
  assert.equal(client.state, 'ready');
  assert.deepEqual([...fake.consumeChannel.consumers.values()].map((consumer) => consumer.queue).sort(), ['jobs', 'late.q']);
  await client.close();
});

test('close() during init wins: the client ends closed, never ready', async () => {
  const fake = createFakeAmqp();
  fake.connectDelayMs = 30;
  const client = makeClient(fake);
  const states = [];
  client.state$.subscribe((state) => states.push(state));
  const init = client.init();
  await sleep(5);
  await client.close();
  await assert.rejects(init, ClientClosedError);
  await sleep(50);
  assert.equal(client.state, 'closed');
  assert.equal(states.includes('ready'), false);
  assert.equal(fake.connection?.closed ?? true, true);
});

test('close() leaves no timers behind (process can exit naturally)', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { drainTimeoutMs: 60000, retryAttempts: 5, retryDelay: 10000 });
  const timersBefore = process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
  await client.init();
  client.forQueue('jobs').subscribe((event) => event.ack());
  await tick();
  fake.consumeChannel.deliver('jobs', {});
  await client.close();
  const timersAfter = process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
  assert.ok(timersAfter <= timersBefore, `timers before ${timersBefore}, after ${timersAfter}`);
});

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

test("topology 'declare' asserts queues, exchanges and bindings", async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { topology: 'declare' });
  await client.init();
  const ops = fake.log.map((entry) => entry[1]);
  assert.ok(ops.includes('assertQueue'));
  assert.ok(ops.includes('assertExchange'));
  assert.ok(ops.includes('bindQueue'));
  await client.close();
});

test("topology 'verify' only uses passive checks and skips bindings", async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { topology: 'verify' });
  await client.init();
  const ops = fake.log.map((entry) => entry[1]);
  assert.deepEqual(ops.filter((op) => /assert|bind|check/.test(op)), ['checkQueue', 'checkExchange']);
  await client.close();
});

test("topology 'verify' rejects init with an error naming the missing resource (no retry)", async () => {
  const fake = createFakeAmqp();
  fake.missing.add('jobs');
  const client = makeClient(fake, { topology: 'verify', retryAttempts: 5 });
  const error = await client.init().catch((e) => e);
  assert.ok(error instanceof TopologyVerificationError);
  assert.equal(error.resource, 'jobs');
  assert.equal(error.resourceType, 'queue');
  assert.match(error.message, /queue "jobs"/);
  assert.equal(fake.connectAttempts, 1);
  assert.equal(client.state, 'idle');
});

test("topology 'none' touches nothing, and onQueue works for queues not in config", async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { topology: 'none', queues: [], exchanges: [], bindings: [] });
  await client.init();
  const ops = fake.log.map((entry) => entry[1]);
  assert.equal(ops.some((op) => /assert|bind|check/.test(op)), false);

  const received = [];
  client.onQueue('other.q').handle('PING').subscribe((event) => { received.push(event); event.ack(); });
  await settleUntil(() => fake.consumeChannel.consumers.size === 1);
  fake.consumeChannel.deliver('other.q', { properties: { type: 'PING' } });
  assert.equal(received.length, 1);
  assert.equal(received[0].queue, 'other.q');
  await client.close();
});

// ---------------------------------------------------------------------------
// Lazy consume, bounded streams, routing
// ---------------------------------------------------------------------------

test('consumption starts on first subscriber and is cancelled after the last unsubscribes', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  const channel = fake.consumeChannel;
  assert.equal(channel.consumers.size, 0);

  const a = client.forQueue('jobs').subscribe(() => {});
  const b = client.onQueue('jobs').handle('X').subscribe(() => {});
  await settleUntil(() => channel.consumers.size === 1);
  a.unsubscribe();
  await tick();
  assert.equal(channel.consumers.size, 1);
  b.unsubscribe();
  await settleUntil(() => channel.consumers.size === 0);
  assert.ok(channel.calls.some((call) => call[0] === 'cancel'));
  await client.close();
});

test('late subscribers receive no historical messages', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { unhandledMessages: 'ack' });
  await client.init();
  const first = [];
  const sub = client.forQueue('jobs').subscribe((event) => { first.push(event); event.ack(); });
  await settleUntil(() => fake.consumeChannel.consumers.size === 1);
  fake.consumeChannel.deliver('jobs', { content: 'one' });
  fake.consumeChannel.deliver('jobs', { content: 'two' });

  const late = [];
  client.forQueue('jobs').subscribe((event) => late.push(event));
  assert.equal(late.length, 0);
  fake.consumeChannel.deliver('jobs', { content: 'three' });
  assert.equal(first.length, 3);
  assert.equal(late.length, 1);
  sub.unsubscribe();
  await client.close({ drainTimeoutMs: 0 });
});

test('routes by properties.type to type streams, callbacks and the default stream', async () => {
  const fake = createFakeAmqp();
  const callbackCalls = [];
  const client = makeClient(fake, {
    queues: [{
      name: 'jobs',
      handleMessageTypes: ['A', { messageName: 'B', callbackHandler: (event) => { callbackCalls.push(event); event.ack(); } }],
    }],
  });
  await client.init();
  // a queue with callback handlers is consumed eagerly
  assert.equal(fake.consumeChannel.consumers.size, 1);

  const typeA = [];
  const untyped = [];
  client.onQueue('jobs').handle('A').subscribe((event) => { typeA.push(event); event.ack(); });
  client.onQueue('jobs').handleDefault().subscribe((event) => { untyped.push(event); event.ack(); });
  await tick();

  const channel = fake.consumeChannel;
  channel.deliver('jobs', { properties: { type: 'A' } });
  channel.deliver('jobs', { properties: { type: 'B' } });
  channel.deliver('jobs', {});
  assert.equal(typeA.length, 1);
  assert.equal(callbackCalls.length, 1);
  assert.equal(untyped.length, 1);

  // unhandled type: default policy nack-requeue
  channel.deliver('jobs', { properties: { type: 'C' } });
  const nack = channel.calls.find((call) => call[0] === 'nack');
  assert.deepEqual(nack, ['nack', 4, true]);
  await client.close();
});

test('legacy autoAckUnhandledMessageTypes maps to the ack policy', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { autoAckUnhandledMessageTypes: true });
  await client.init();
  client.onQueue('jobs').handle('A').subscribe(() => {});
  await tick();
  fake.consumeChannel.deliver('jobs', { properties: { type: 'Z' } });
  assert.deepEqual(fake.consumeChannel.calls.filter((call) => call[0] === 'ack'), [['ack', 1]]);
  await client.close({ drainTimeoutMs: 0 });
});

test("unhandledMessages 'default' pushes unknown types to the default stream", async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { unhandledMessages: 'default' });
  await client.init();
  const fallback = [];
  client.onQueue('jobs').handleDefault().subscribe((event) => { fallback.push(event); event.ack(); });
  await tick();
  fake.consumeChannel.deliver('jobs', { properties: { type: 'Z' } });
  assert.equal(fallback.length, 1);
  await client.close();
});

test('serializer selection: instance serializers, content type, default content type', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, {
    defaultContentType: 'application/x-test',
    serializers: {
      'application/x-test': {
        serialize: (value) => Buffer.from(`test:${JSON.stringify(value)}`),
        deserialize: (bytes) => bytes.toString('utf8').replace(/^test:/, ''),
      },
    },
  });
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => { received.push(event.data); event.ack(); });
  await tick();
  fake.consumeChannel.deliver('jobs', { content: 'test:{"a":1}' });
  fake.consumeChannel.deliver('jobs', { content: '{"b":2}', properties: { contentType: 'application/json' } });
  assert.deepEqual(received, ['{"a":1}', { b: 2 }]);

  await client.sendMessage({ queue: 'jobs', data: { ok: true }, publishOptions: {} });
  const publish = fake.publishChannel.calls.find((call) => call[0] === 'publish');
  assert.equal(publish[3].toString('utf8'), 'test:{"ok":true}');
  await client.close();
});

test('undeserializable messages are rejected without requeue and reported', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event));
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', { content: '{not json', properties: { contentType: 'application/json' } });
  assert.equal(received.length, 0);
  assert.deepEqual(fake.consumeChannel.calls.find((call) => call[0] === 'nack'), ['nack', 1, false]);
  assert.equal(errors[0].type, 'handler-error');
  await client.close();
});

// ---------------------------------------------------------------------------
// Reconnect & channel resilience
// ---------------------------------------------------------------------------

test('subscriptions survive a reconnect and consumers are re-issued (R4)', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  const received = [];
  client.onQueue('jobs').handle('A').subscribe((event) => { received.push(event.data); event.ack(); });
  await tick();
  fake.consumeChannel.deliver('jobs', { content: 'before', properties: { type: 'A' } });

  fake.connection.kill();
  await waitForState(client, 'ready');
  assert.equal(fake.connections.length, 2);
  assert.equal(fake.consumeChannel.consumers.size, 1);
  fake.consumeChannel.deliver('jobs', { content: 'after', properties: { type: 'A' } });
  assert.deepEqual(received.map(String), ['before', 'after']);
  await client.close();
});

test('consume channel failure leaves ready, recreates the channel and re-consumes (R6)', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event.type));
  await client.init();
  client.forQueue('jobs').subscribe((event) => event.ack());
  await tick();
  const oldChannel = fake.consumeChannel;

  oldChannel.serverClose(406, 'PRECONDITION_FAILED - unknown delivery tag 1');
  assert.equal(client.state, 'reconnecting');
  await waitForState(client, 'ready');
  assert.notEqual(fake.consumeChannel, oldChannel);
  assert.equal(fake.connections.length, 1, 'connection is reused');
  assert.equal(fake.consumeChannel.consumers.size, 1);
  assert.ok(errors.includes('channel-error'));
  assert.ok(errors.includes('channel-closed'));
  assert.equal(client.getMetrics().channelRecreated, 1);
  await client.close();
});

test('acks for deliveries from a dead channel are dropped (no 406 on the new channel)', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', {});
  fake.connection.kill();
  await waitForState(client, 'ready');
  received[0].ack();
  assert.equal(received[0].settled, true);
  assert.equal(fake.consumeChannel.calls.some((call) => call[0] === 'ack'), false);
  await client.close();
});

test('server-side consumer cancel is reported on errors$ and the consumer is re-issued', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event));
  await client.init();
  client.forQueue('jobs').subscribe(() => {});
  await tick();
  fake.consumeChannel.serverCancel('jobs');
  assert.equal(client.state, 'reconnecting');
  assert.equal(errors[0].type, 'consumer-cancelled');
  assert.equal(errors[0].queue, 'jobs');
  await waitForState(client, 'ready');
  assert.equal(fake.consumeChannel.consumers.size, 1);
  await client.close();
});

test('event.ack() twice only acks once', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', {});
  received[0].ack();
  received[0].ack();
  client.ack(received[0].message);
  assert.equal(fake.consumeChannel.calls.filter((call) => call[0] === 'ack').length, 1);
  await sleep(5);
  assert.equal(client.state, 'ready');
  await client.close();
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

test('confirmed publish resolves on broker ack', async () => {
  const fake = createFakeAmqp();
  fake.confirmMode = 'manual';
  const client = makeClient(fake);
  await client.init();
  let resolved = false;
  const publish = client.publishEvent({ exchange: 'app.ex', routingKey: 'jobs.created', data: 'x', publishOptions: {} }).then(() => { resolved = true; });
  await settleUntil(() => fake.publishChannel.pendingConfirms.length === 1);
  assert.equal(resolved, false);
  fake.publishChannel.ackNextPublish();
  await publish;
  assert.equal(resolved, true);
  assert.equal(client.getMetrics().publishConfirmed, 1);
  await client.close();
});

test('broker nack rejects with PublishNackedError', async () => {
  const fake = createFakeAmqp();
  fake.confirmMode = 'manual';
  const client = makeClient(fake);
  await client.init();
  const publish = client.sendMessage({ queue: 'jobs', data: 'x', publishOptions: {} });
  await settleUntil(() => fake.publishChannel.pendingConfirms.length === 1);
  fake.publishChannel.nackNextPublish();
  await assert.rejects(publish, PublishNackedError);
  assert.equal(client.getMetrics().publishNacked, 1);
  await client.close();
});

test('mandatory + basic.return rejects with PublishReturnedError (correlated by messageId)', async () => {
  const fake = createFakeAmqp();
  fake.confirmMode = 'manual';
  const client = makeClient(fake);
  await client.init();
  const other = client.publishEvent({ exchange: 'app.ex', routingKey: 'ok', data: 'a', publishOptions: { mandatory: true } });
  const returned = client.publishEvent({ exchange: 'app.ex', routingKey: 'nowhere', data: 'b', publishOptions: { mandatory: true } });
  await settleUntil(() => fake.publishChannel.pendingConfirms.length === 2);
  const [first, second] = fake.publishChannel.pendingConfirms;
  assert.ok(second.options.messageId, 'a messageId is generated for correlation');
  fake.publishChannel.returnPublished(second);
  fake.publishChannel.ackNextPublish();
  fake.publishChannel.ackNextPublish();
  await other;
  const error = await returned.catch((e) => e);
  assert.ok(error instanceof PublishReturnedError);
  assert.equal(error.replyCode, 312);
  assert.equal(error.routingKey, 'nowhere');
  void first;
  await client.close();
});

test('channel closed before confirm rejects with PublishChannelClosedError carrying the broker error, then recovers', async () => {
  const fake = createFakeAmqp();
  fake.confirmMode = 'manual';
  const client = makeClient(fake);
  await client.init();
  const publish = client.publishEvent({ exchange: 'missing', data: 'x', publishOptions: {} });
  await settleUntil(() => fake.publishChannel.pendingConfirms.length === 1);
  const publishChannel = fake.publishChannel;
  publishChannel.serverClose(404, "NOT_FOUND - no exchange 'missing'");
  const error = await publish.catch((e) => e);
  assert.ok(error instanceof PublishChannelClosedError);
  assert.match(error.cause.message, /404/);
  await waitForState(client, 'ready');
  assert.notEqual(fake.publishChannel, publishChannel);
  fake.confirmMode = 'auto';
  await client.publishEvent({ exchange: 'app.ex', data: 'y', publishOptions: {} });
  await client.close();
});

test('backpressure: publishes wait for drain when publish() returns false', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  const channel = fake.publishChannel;
  channel.publishReturnValue = false;
  await client.sendMessage({ queue: 'jobs', data: '1', publishOptions: {} });
  channel.publishReturnValue = true;
  let second = false;
  const pending = client.sendMessage({ queue: 'jobs', data: '2', publishOptions: {} }).then(() => { second = true; });
  await sleep(20);
  assert.equal(second, false);
  assert.equal(channel.calls.filter((call) => call[0] === 'publish').length, 1);
  channel.emit('drain');
  await pending;
  assert.equal(channel.calls.filter((call) => call[0] === 'publish').length, 2);
  await client.close();
});

test('confirm: false resolves once written (and still waits for drain)', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { confirm: false });
  await client.init();
  const channel = client.getPublishChannel();
  assert.equal(channel.confirm, false);
  channel.publishReturnValue = false;
  let done = false;
  const pending = client.sendMessage({ queue: 'jobs', data: '1', publishOptions: {} }).then(() => { done = true; });
  await sleep(10);
  assert.equal(done, false);
  channel.emit('drain');
  await pending;
  await client.close();
});

test('publishing while not ready waits up to readyTimeoutMs, then rejects', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, { readyTimeoutMs: 30 });
  await assert.rejects(client.sendMessage({ queue: 'jobs', data: 'x', publishOptions: {} }), ClientNotReadyError);

  const waiting = client.sendMessage({ queue: 'jobs', data: 'y', publishOptions: {} });
  await client.init();
  await waiting;
  await client.close();
  await assert.rejects(client.sendMessage({ queue: 'jobs', data: 'z', publishOptions: {} }), ClientClosedError);
});

test('onPublish and onDeliver hooks run; a throwing hook does not fail the publish', async () => {
  const fake = createFakeAmqp();
  const delivered = [];
  let throwNext = false;
  const client = makeClient(fake, {
    hooks: {
      onPublish: (properties, target) => {
        if (throwNext) throw new Error('hook failed');
        properties.headers.traceparent = `00-trace-${target.exchange}-01`;
      },
      onDeliver: (event) => delivered.push([event.queue, event.message.properties.headers.traceparent]),
    },
  });
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event.type));
  await client.init();
  await client.publishEvent({ exchange: 'app.ex', data: 'x', publishOptions: { headers: { a: 1 } } });
  const publish = fake.publishChannel.calls.find((call) => call[0] === 'publish');
  assert.deepEqual(publish[4].headers, { a: 1, traceparent: '00-trace-app.ex-01' });

  throwNext = true;
  await client.publishEvent({ exchange: 'app.ex', data: 'x', publishOptions: {} });
  assert.deepEqual(errors, ['hook-error']);

  client.forQueue('jobs').subscribe((event) => event.ack());
  await tick();
  fake.consumeChannel.deliver('jobs', { properties: { headers: { traceparent: 'tp' } } });
  assert.deepEqual(delivered, [['jobs', 'tp']]);
  await client.close();
});

// ---------------------------------------------------------------------------
// Republish (R7)
// ---------------------------------------------------------------------------

test('republish acks the original strictly after the copy is confirmed', async () => {
  const fake = createFakeAmqp();
  fake.confirmMode = 'manual';
  const client = makeClient(fake);
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', {
    content: 'body',
    properties: { type: 'A', userId: 'someone-else', messageId: 'm-1', headers: { 'x-retry-count': 1, keep: 'yes' } },
  });

  const republish = received[0].republish({ exchange: 'retry.ex', routingKey: 'jobs.retry.5s', headers: { 'x-retry-count': 2 } });
  await settleUntil(() => fake.publishChannel.pendingConfirms.length === 1);
  const [entry] = fake.publishChannel.pendingConfirms;
  assert.equal(entry.exchange, 'retry.ex');
  assert.equal(entry.routingKey, 'jobs.retry.5s');
  assert.equal(entry.content.toString(), 'body');
  assert.deepEqual(entry.options.headers, { 'x-retry-count': 2, keep: 'yes' });
  assert.equal(entry.options.type, 'A');
  assert.equal(entry.options.mandatory, true);
  assert.equal(entry.options.userId, undefined);
  assert.equal(fake.consumeChannel.calls.some((call) => call[0] === 'ack' || call[0] === 'nack'), false, 'original untouched before confirm');

  received[0].ack(); // ignored while the republish is in flight
  fake.publishChannel.ackNextPublish();
  await republish;
  const order = fake.log.map((entry) => entry[1]).filter((op) => op === 'publish' || op === 'ack');
  assert.deepEqual(order, ['publish', 'ack']);
  assert.equal(fake.consumeChannel.calls.filter((call) => call[0] === 'ack').length, 1);
  await assert.rejects(received[0].republish({ exchange: 'retry.ex', routingKey: 'x' }), MessageAlreadySettledError);
  await client.close();
});

test('republish failure nack-requeues the original and rejects', async () => {
  const fake = createFakeAmqp();
  fake.confirmMode = 'manual';
  const client = makeClient(fake);
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', {});
  const republish = received[0].republish({ exchange: 'dlx', routingKey: 'jobs' });
  await settleUntil(() => fake.publishChannel.pendingConfirms.length === 1);
  fake.publishChannel.nackNextPublish();
  await assert.rejects(republish, PublishNackedError);
  assert.deepEqual(fake.consumeChannel.calls.find((call) => call[0] === 'nack'), ['nack', 1, true]);
  assert.equal(received[0].settled, true);
  await client.close();
});

test('deprecated retryMessage/deadLetter copy first and ack after (never nack before the copy exists)', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', { fields: { routingKey: 'some.routing.key' } });
  fake.consumeChannel.deliver('jobs', {});
  await received[0].retry({ queue: 'jobs.retry' });
  await client.deadLetter(received[1].message, 'boom');
  const ops = fake.log.filter((entry) => ['publish', 'ack', 'nack'].includes(entry[1])).map((entry) => entry[1] === 'publish' ? `publish:${entry[3]}` : entry[1]);
  assert.deepEqual(ops, ['publish:jobs.retry', 'ack', 'publish:jobs.dlq', 'ack']);
  const deadLetter = fake.publishChannel.calls.filter((call) => call[0] === 'publish')[1];
  assert.equal(deadLetter[4].headers['x-death-reason'], 'boom');
  await client.close();
});

test('handleMessageError supports DLX exchanges and logs the consumed queue', async () => {
  const fake = createFakeAmqp();
  const logged = [];
  const client = makeClient(fake, { logger: { ...silent, error: (...args) => logged.push(args) } });
  await client.init();
  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', { fields: { routingKey: 'jobs.created' } });
  fake.consumeChannel.deliver('jobs', {});

  const outcome = await received[0].handlerError(new Error('failed'), { deadLetterExchange: 'dlx.topic' });
  assert.deepEqual(outcome, { action: 'dead-letter', targetExchange: 'dlx.topic', routingKey: 'jobs' });
  assert.equal(logged[0][1].queue, 'jobs');
  assert.equal(logged[0][1].routingKey, 'jobs.created');

  const nackOutcome = await received[1].handlerError(new Error('failed'), { requeue: true });
  assert.deepEqual(nackOutcome, { action: 'nack', requeue: true });
  await client.close();
});

// ---------------------------------------------------------------------------
// Graceful shutdown (R5)
// ---------------------------------------------------------------------------

test('close() cancels consumers, waits for in-flight handlers and confirms, then closes', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  let finished = false;
  client.onQueue('jobs').handleAll(async (event) => {
    await sleep(60);
    await event.publishEvent({ exchange: 'app.ex', data: 'side effect', publishOptions: {} });
    finished = true;
    event.ack();
  });
  await tick();
  const channel = fake.consumeChannel;
  channel.deliver('jobs', {});

  const closing = client.close({ drainTimeoutMs: 2000 });
  assert.equal(client.state, 'closing');
  await settleUntil(() => channel.calls.some((call) => call[0] === 'cancel'));
  assert.equal(fake.connection.closed, false);
  await closing;
  assert.equal(finished, true);
  const ops = fake.log.map((entry) => entry[1]);
  assert.ok(ops.indexOf('cancel') < ops.indexOf('ack'));
  assert.ok(ops.lastIndexOf('ack') < ops.lastIndexOf('close'));
  assert.equal(fake.connection.closed, true);
});

test('close() gives up draining after drainTimeoutMs', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  client.forQueue('jobs').subscribe(() => { /* never settles */ });
  await tick();
  fake.consumeChannel.deliver('jobs', {});
  const started = Date.now();
  await client.close({ drainTimeoutMs: 50 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(client.state, 'closed');
});

test('stopConsuming cancels and is sticky across reconnects until startConsuming', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  await client.init();
  client.forQueue('jobs').subscribe(() => {});
  await tick();
  await client.stopConsuming('jobs');
  assert.equal(fake.consumeChannel.consumers.size, 0);
  fake.connection.kill();
  await waitForState(client, 'ready');
  assert.equal(fake.consumeChannel.consumers.size, 0);
  await client.startConsuming('jobs');
  assert.equal(fake.consumeChannel.consumers.size, 1);
  await client.close();
});

test('callback handler errors nack-requeue unsettled messages and are reported', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake, {
    queues: [{ name: 'jobs', handleMessageTypes: [{ messageName: 'A', callbackHandler: async () => { throw new Error('boom'); } }] }],
  });
  const errors = [];
  client.errors$.subscribe((event) => errors.push(event));
  await client.init();
  fake.consumeChannel.deliver('jobs', { properties: { type: 'A' } });
  await settleUntil(() => errors.length === 1);
  assert.equal(errors[0].type, 'handler-error');
  assert.equal(errors[0].messageType, 'A');
  assert.deepEqual(fake.consumeChannel.calls.find((call) => call[0] === 'nack'), ['nack', 1, true]);
  await client.close();
});

test('metrics include confirm and channel counters', async () => {
  const fake = createFakeAmqp();
  const client = makeClient(fake);
  assert.deepEqual(client.getMetrics(), {
    messagesReceived: 0,
    messagesPublished: 0,
    messagesAcked: 0,
    messagesNacked: 0,
    messagesRetried: 0,
    rpcRequests: 0,
    rpcResponses: 0,
    reconnects: 0,
    publishConfirmed: 0,
    publishNacked: 0,
    publishReturned: 0,
    channelRecreated: 0,
  });
  await client.close();
});
