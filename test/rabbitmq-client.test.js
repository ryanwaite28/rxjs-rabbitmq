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
