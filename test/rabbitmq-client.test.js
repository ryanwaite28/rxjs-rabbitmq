const test = require('node:test');
const assert = require('node:assert/strict');
const { RabbitMQClient, registerSerializer } = require('../dist');

test('client supports clean shutdown and metrics inspection without a live connection', async () => {
  const client = new RabbitMQClient({
    stopAutoInit: true,
    metrics: true,
    connection_url: 'amqp://localhost',
    retryAttempts: 1,
    retryDelay: 50,
    queues: [],
    exchanges: [],
    bindings: []
  });

  assert.deepEqual(client.getMetrics(), {
    messagesReceived: 0,
    messagesPublished: 0,
    messagesAcked: 0,
    messagesNacked: 0,
    messagesRetried: 0,
    rpcRequests: 0,
    rpcResponses: 0,
    reconnects: 0
  });

  await assert.doesNotReject(() => client.close());
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
  const client = new RabbitMQClient({
    stopAutoInit: true,
    metrics: false,
    connection_url: 'amqp://localhost',
    retryAttempts: 1,
    retryDelay: 10,
    queues: [],
    exchanges: [],
    bindings: []
  });

  const calls = [];
  client.channel = {
    assertExchange: async (name, type, options) => {
      calls.push(['assertExchange', name, type, options]);
      return { exchange: name };
    },
    assertQueue: async (name, options) => {
      calls.push(['assertQueue', name, options]);
      return { queue: name, messageCount: 0, consumerCount: 0 };
    },
    bindQueue: async (queue, exchange, routingKey) => {
      calls.push(['bindQueue', queue, exchange, routingKey]);
      return {};
    },
    sendToQueue: (queue, content, options) => {
      calls.push(['sendToQueue', queue, content, options]);
      return {};
    },
    nack: (message, allUpTo, requeue) => {
      calls.push(['nack', message, allUpTo, requeue]);
    },
    ack: (message) => {
      calls.push(['ack', message]);
    }
  };

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

  const message = {
    fields: { routingKey: 'jobs' },
    properties: { headers: {}, contentType: 'application/json' },
    content: Buffer.from('boom')
  };

  const outcome = client.handleMessageError(message, new Error('failed processing'), {
    deadLetterQueue: 'jobs.dlq',
    reason: 'processing failed'
  });

  assert.equal(outcome.action, 'dead-letter');
  assert.equal(calls.some((call) => call[0] === 'sendToQueue' && call[1] === 'jobs.dlq'), true);
});
