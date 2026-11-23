// Smoke test: the package works from an ESM consumer through named and default imports,
// and both import styles share one module instance with the CJS build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import rxjsRabbitmq, { RabbitMQClient, PublishNackedError, ContentTypes } from 'rxjs-rabbitmq';

const require = createRequire(import.meta.url);

test('ESM named and default imports resolve', () => {
  assert.equal(typeof RabbitMQClient, 'function');
  assert.equal(rxjsRabbitmq.RabbitMQClient, RabbitMQClient);
  assert.equal(ContentTypes.JSON, 'application/json');
});

test('ESM and CJS entry points share one module instance', () => {
  const cjs = require('rxjs-rabbitmq');
  assert.equal(cjs.RabbitMQClient, RabbitMQClient);
  assert.equal(cjs.PublishNackedError, PublishNackedError);
});

test('a client can be constructed and closed from ESM', async () => {
  const client = new RabbitMQClient({ stopAutoInit: true, connection_url: 'amqp://localhost', logger: { info() {}, warn() {}, error() {} } });
  assert.equal(client.state, 'idle');
  await client.close();
  assert.equal(client.state, 'closed');
});
