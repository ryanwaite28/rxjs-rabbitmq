'use strict';
// Ports of the 2.x test suite onto the 3.0 API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { RabbitMQClient, registerSerializer } = require('../../dist/cjs');
const { createFakeAmqp } = require('../helpers/fake-amqp');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('client supports clean shutdown and metrics inspection without a live connection', async () => {
  const client = new RabbitMQClient({
    stopAutoInit: true,
    metrics: true,
    logger: silent,
    connection_url: 'amqp://localhost',
    retryAttempts: 1,
    retryDelay: 50,
    queues: [],
    exchanges: [],
    bindings: []
  });

  assert.equal(client.getMetrics().messagesReceived, 0);
  await assert.doesNotReject(() => client.close());
  assert.equal(client.state, 'closed');
});

test('custom serializers can be registered and used', () => {
  const contentType = 'application/test+json';

  const serializer = {
    serialize: (value) => Buffer.from(JSON.stringify(value)),
    deserialize: (bytes) => JSON.parse(bytes.toString('utf8'))
  };

  assert.doesNotThrow(() => {
    registerSerializer(contentType, serializer);
    RabbitMQClient.registerSerializer(contentType, serializer);
  });

  const payload = { ok: true, count: 2 };
  assert.deepEqual(
    registerSerializer(contentType, serializer).deserialize(registerSerializer(contentType, serializer).serialize(payload)),
    payload
  );
});

test('dead letter setup and error handling can be configured through the client helper', async () => {
  const fake = createFakeAmqp();
  const client = new RabbitMQClient({
    stopAutoInit: true,
    connect: fake.connect,
    logger: silent,
    connection_url: 'amqp://localhost',
    queues: [],
    exchanges: [],
    bindings: []
  });
  await client.init();

  const result = await client.setupDeadLetterQueue({
    sourceQueue: 'jobs',
    deadLetterQueue: 'jobs.dlq',
    deadLetterExchange: 'jobs.dlx',
    deadLetterRoutingKey: 'jobs.dlq',
    queueOptions: { durable: true },
    deadLetterQueueOptions: { durable: true },
    messageTtlMs: 5000,
  });

  assert.equal(result.deadLetterQueue, 'jobs.dlq');
  assert.equal(result.deadLetterExchange, 'jobs.dlx');

  const received = [];
  client.forQueue('jobs').subscribe((event) => received.push(event));
  await tick();
  fake.consumeChannel.deliver('jobs', { content: 'boom', properties: { contentType: 'text/plain' } });

  const outcome = await client.handleMessageError(received[0].message, new Error('failed processing'), {
    deadLetterQueue: 'jobs.dlq',
    reason: 'processing failed'
  });

  assert.equal(outcome.action, 'dead-letter');
  const publish = fake.publishChannel.calls.find((call) => call[0] === 'publish');
  assert.equal(publish[1], '');
  assert.equal(publish[2], 'jobs.dlq');
  assert.equal(publish[4].headers['x-death-reason'], 'processing failed');
  await client.close();
});

test('constructor serializers are instance scoped and used automatically', async () => {
  const fake = createFakeAmqp();
  const contentType = 'application/instance-test';
  const serializer = {
    serialize: (value) => Buffer.from(`instance:${JSON.stringify(value)}`),
    deserialize: (bytes) => bytes.toString('utf8').replace(/^instance:/, '')
  };

  const client = new RabbitMQClient({
    stopAutoInit: true,
    connect: fake.connect,
    logger: silent,
    connection_url: 'amqp://localhost',
    defaultContentType: contentType,
    serializers: { [contentType]: serializer },
    queues: [],
    exchanges: [],
    bindings: []
  });
  await client.init();

  await client.sendMessage({ queue: 'jobs', data: { ok: true }, publishOptions: {} });
  const publish = fake.publishChannel.calls.find((call) => call[0] === 'publish');
  assert.equal(publish[3].toString('utf8'), 'instance:{"ok":true}');

  let event;
  client.onMessage.subscribe((received) => { event = received; });
  client.forQueue('jobs').subscribe((received) => received.ack());
  await tick();
  fake.consumeChannel.deliver('jobs', { content: 'instance:{"ok":true}', properties: { contentType } });

  assert.equal(event.data, '{"ok":true}');
  await client.close();
});

test('event messages expose client convenience methods', async () => {
  const fake = createFakeAmqp();
  const client = new RabbitMQClient({
    stopAutoInit: true,
    connect: fake.connect,
    logger: silent,
    connection_url: 'amqp://localhost',
    queues: [],
    exchanges: [],
    bindings: []
  });
  await client.init();

  const received = [];
  client.onMessage.subscribe((event) => received.push(event));
  client.forQueue('jobs').subscribe(() => {});
  await tick();
  fake.consumeChannel.deliver('jobs', { content: 'test', properties: { contentType: 'application/octet-stream' } });
  fake.consumeChannel.deliver('jobs', { content: 'test', properties: { contentType: 'application/octet-stream' } });

  assert.equal(received.length, 2);
  assert.equal(typeof received[0].nack, 'function');
  assert.equal(typeof received[0].retry, 'function');
  assert.equal(typeof received[0].republish, 'function');
  assert.equal(typeof received[0].handlerError, 'function');
  assert.equal(received[0].queue, 'jobs');

  received[0].nack(false);
  assert.deepEqual(fake.consumeChannel.calls.find((call) => call[0] === 'nack'), ['nack', 1, false]);

  const outcome = await received[1].handlerError(new Error('failed'), { requeue: true });
  assert.equal(outcome.action, 'nack');
  assert.equal(outcome.requeue, true);
  await client.close();
});
