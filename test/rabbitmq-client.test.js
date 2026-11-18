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

test('constructor serializers are instance scoped and used automatically', () => {
  const contentType = 'application/instance-test';
  const serializer = {
    serialize: (value) => Buffer.from(`instance:${JSON.stringify(value)}`),
    deserialize: (bytes) => bytes.toString('utf8').replace(/^instance:/, '')
  };

  const client = new RabbitMQClient({
    stopAutoInit: true,
    connection_url: 'amqp://localhost',
    retryAttempts: 1,
    retryDelay: 10,
    defaultContentType: contentType,
    serializers: { [contentType]: serializer },
    queues: [],
    exchanges: [],
    bindings: []
  });

  let sentPayload;
  client.channel = {
    sendToQueue: (queue, content, options) => {
      sentPayload = { queue, content, options };
      return true;
    }
  };
  client.isReady = true;

  client.sendMessage({
    queue: 'jobs',
    data: { ok: true },
    publishOptions: {}
  });

  assert.equal(sentPayload.content.toString('utf8'), 'instance:{"ok":true}');

  let consumeHandler;
  const incomingMessage = {
    fields: { routingKey: 'jobs' },
    properties: { contentType, headers: {} },
    content: Buffer.from('instance:{"ok":true}')
  };

  client.channel = {
    consume: (queue, handler) => {
      consumeHandler = handler;
      return Promise.resolve({ consumerTag: 'serializer-test' });
    }
  };

  let event;
  client.onMessage.subscribe((received) => { event = received; });
  client.getQueueListener('jobs')();
  consumeHandler(incomingMessage);

  assert.equal(event.data, '{"ok":true}');
});

test('event messages expose client convenience methods', () => {
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

  let consumeHandler;
  client.channel = {
    consume: (queue, handler) => {
      consumeHandler = handler;
      return Promise.resolve({ consumerTag: 'test-consumer' });
    },
    nack: (message, allUpTo, requeue) => {
      message.testNackRequeue = requeue;
    },
    sendToQueue: () => true,
  };

  const received = [];
  client.onMessage.subscribe((event) => received.push(event));
  client.getQueueListener('jobs')();

  const message = {
    fields: { routingKey: 'jobs' },
    properties: { headers: {}, contentType: 'application/octet-stream' },
    content: Buffer.from('test')
  };

  consumeHandler(message);

  assert.equal(received.length, 1);
  assert.equal(typeof received[0].nack, 'function');
  assert.equal(typeof received[0].retry, 'function');
  assert.equal(typeof received[0].handlerError, 'function');

  received[0].nack(false);
  assert.equal(message.testNackRequeue, false);

  const outcome = received[0].handlerError(new Error('failed'), { requeue: true });
  assert.equal(outcome.action, 'nack');
  assert.equal(outcome.requeue, true);
});
