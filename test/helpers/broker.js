'use strict';
// RabbitMQ 4.x for integration tests: a Testcontainers broker by default, or an external
// broker via RABBITMQ_AMQP_URL + RABBITMQ_MGMT_URL (admin credentials embedded in both URLs).
const amqplib = require('amqplib');

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin';
const IMAGE = process.env.RABBITMQ_IMAGE || 'rabbitmq:4-management';

async function startBroker() {
  if (process.env.RABBITMQ_AMQP_URL && process.env.RABBITMQ_MGMT_URL) {
    const amqp = new URL(process.env.RABBITMQ_AMQP_URL);
    const mgmt = new URL(process.env.RABBITMQ_MGMT_URL);
    return makeBroker({ host: amqp.hostname, amqpPort: Number(amqp.port || 5672), mgmtBase: mgmt.origin, user: decodeURIComponent(amqp.username), pass: decodeURIComponent(amqp.password), stop: async () => {} });
  }

  const { GenericContainer, Wait } = require('testcontainers');
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({ RABBITMQ_DEFAULT_USER: ADMIN_USER, RABBITMQ_DEFAULT_PASS: ADMIN_PASS })
    .withCopyContentToContainer([{
      content: 'collect_statistics_interval = 500\nmanagement.rates_mode = none\n',
      target: '/etc/rabbitmq/conf.d/90-tests.conf',
    }])
    .withExposedPorts(5672, 15672)
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .withStartupTimeout(120000)
    .start();

  return makeBroker({
    host: container.getHost(),
    amqpPort: container.getMappedPort(5672),
    mgmtBase: `http://${container.getHost()}:${container.getMappedPort(15672)}`,
    user: ADMIN_USER,
    pass: ADMIN_PASS,
    stop: () => container.stop(),
  });
}

function makeBroker({ host, amqpPort, mgmtBase, user, pass, stop }) {
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  async function mgmt(method, path, body) {
    const response = await fetch(`${mgmtBase}/api${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json', 'x-reason': 'integration test' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  const broker = {
    url: (username = user, password = pass) => `amqp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${amqpPort}`,
    mgmt,
    stop,

    async createUser(username, password, permissions) {
      await mgmt('PUT', `/users/${encodeURIComponent(username)}`, { password, tags: '' });
      await mgmt('PUT', `/permissions/%2F/${encodeURIComponent(username)}`, permissions);
    },

    /** Run fn with an admin channel (for declaring topology out of band). */
    async admin(fn) {
      const connection = await amqplib.connect(broker.url());
      const channel = await connection.createChannel();
      try {
        return await fn(channel);
      } finally {
        await channel.close().catch(() => {});
        await connection.close().catch(() => {});
      }
    },

    async connectionsNamed(name) {
      const connections = (await mgmt('GET', '/connections')) || [];
      return connections.filter((connection) => connection.client_properties && connection.client_properties.connection_name === name);
    },

    async waitFor(predicate, { timeoutMs = 20000, intervalMs = 100, message = 'condition' } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },

    async killConnections(name) {
      const connections = await broker.waitFor(async () => {
        const list = await broker.connectionsNamed(name);
        return list.length > 0 ? list : null;
      }, { message: `connection ${name} to show up in management API` });
      for (const connection of connections) {
        await mgmt('DELETE', `/connections/${encodeURIComponent(connection.name)}`);
      }
      return connections.length;
    },

    async queue(name) {
      return mgmt('GET', `/queues/%2F/${encodeURIComponent(name)}`);
    },

    async deleteQueue(name) {
      await mgmt('DELETE', `/queues/%2F/${encodeURIComponent(name)}`);
    },
  };
  return broker;
}

module.exports = { startBroker };
