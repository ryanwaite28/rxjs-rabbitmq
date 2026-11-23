'use strict';
// A minimal in-memory stand-in for amqplib's promise API, with test controls for
// confirms, returns, backpressure, server-side cancels and channel/connection failures.
const { EventEmitter } = require('node:events');

let tagCounter = 0;

function closeError(code, text) {
  const error = new Error(`Channel closed by server: ${code} (${text})`);
  error.code = code;
  return error;
}

class FakeChannel extends EventEmitter {
  constructor(connection, { confirm }) {
    super();
    this.connection = connection;
    this.confirm = confirm;
    this.closed = false;
    this.calls = [];
    this.consumers = new Map();
    this.pendingConfirms = [];
    this.settledTags = new Set();
    this.deliveryTag = 0;
    this.publishReturnValue = true;
  }

  record(...call) {
    this.calls.push(call);
    this.connection.fake.log.push([this.confirm ? 'publish-channel' : 'channel', ...call]);
  }

  ensureOpen() {
    if (this.closed) {
      const error = new Error('Channel closed');
      error.name = 'IllegalOperationError';
      throw error;
    }
  }

  async prefetch(count) { this.ensureOpen(); this.record('prefetch', count); return {}; }
  async assertQueue(name, options) { this.ensureOpen(); this.record('assertQueue', name, options); return { queue: name, messageCount: 0, consumerCount: 0 }; }
  async assertExchange(name, type, options) { this.ensureOpen(); this.record('assertExchange', name, type, options); return { exchange: name }; }
  async bindQueue(queue, exchange, key) { this.ensureOpen(); this.record('bindQueue', queue, exchange, key); return {}; }

  async checkQueue(name) {
    this.ensureOpen();
    this.record('checkQueue', name);
    if (this.connection.fake.missing.has(name)) {
      this.serverClose(404, `NOT_FOUND - no queue '${name}'`);
      throw new Error(`Operation failed: QueueDeclare; 404 (NOT-FOUND) with message "NOT_FOUND - no queue '${name}'"`);
    }
    return { queue: name, messageCount: 0, consumerCount: 0 };
  }

  async checkExchange(name) {
    this.ensureOpen();
    this.record('checkExchange', name);
    if (this.connection.fake.missing.has(name)) {
      this.serverClose(404, `NOT_FOUND - no exchange '${name}'`);
      throw new Error(`Operation failed: ExchangeDeclare; 404 (NOT-FOUND) with message "NOT_FOUND - no exchange '${name}'"`);
    }
    return {};
  }

  async consume(queue, callback, options = {}) {
    this.ensureOpen();
    this.record('consume', queue, options);
    if (this.connection.fake.consumeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.connection.fake.consumeDelayMs));
    this.ensureOpen();
    if (this.connection.fake.missing.has(queue)) {
      this.serverClose(404, `NOT_FOUND - no queue '${queue}'`);
      throw new Error(`Operation failed: BasicConsume; 404 (NOT-FOUND)`);
    }
    tagCounter += 1;
    const consumerTag = options.consumerTag || `ctag-${tagCounter}`;
    this.consumers.set(consumerTag, { queue, callback, options });
    return { consumerTag };
  }

  async cancel(consumerTag) {
    this.ensureOpen();
    this.record('cancel', consumerTag);
    this.consumers.delete(consumerTag);
    return { consumerTag };
  }

  ack(message) {
    this.ensureOpen();
    this.record('ack', message.fields.deliveryTag);
    this.checkTag(message);
  }

  nack(message, _allUpTo, requeue) {
    this.ensureOpen();
    this.record('nack', message.fields.deliveryTag, requeue);
    this.checkTag(message);
  }

  checkTag(message) {
    const tag = message.fields.deliveryTag;
    if (message.__channel !== this || this.settledTags.has(tag)) {
      setImmediate(() => this.serverClose(406, `PRECONDITION_FAILED - unknown delivery tag ${tag}`));
      return;
    }
    this.settledTags.add(tag);
  }

  publish(exchange, routingKey, content, options = {}, callback) {
    this.ensureOpen();
    this.record('publish', exchange, routingKey, content, options);
    const entry = { exchange, routingKey, content, options, callback };
    if (this.confirm) {
      this.pendingConfirms.push(entry);
      const mode = this.connection.fake.confirmMode;
      if (mode === 'auto') {
        setImmediate(() => this.resolveConfirm(entry, null));
      }
    }
    return this.publishReturnValue;
  }

  sendToQueue(queue, content, options, callback) {
    return this.publish('', queue, content, options, callback);
  }

  async close() {
    this.record('close');
    this.toClosed();
  }

  // ---- test controls ----

  resolveConfirm(entry, error) {
    const index = this.pendingConfirms.indexOf(entry);
    if (index < 0) return;
    this.pendingConfirms.splice(index, 1);
    if (entry.callback) entry.callback(error, {});
  }

  ackNextPublish() {
    const entry = this.pendingConfirms[0];
    if (!entry) throw new Error('no pending confirm');
    this.resolveConfirm(entry, null);
  }

  nackNextPublish() {
    const entry = this.pendingConfirms[0];
    if (!entry) throw new Error('no pending confirm');
    this.resolveConfirm(entry, new Error('message nacked'));
  }

  returnPublished(entry, replyCode = 312, replyText = 'NO_ROUTE') {
    this.emit('return', {
      content: entry.content,
      fields: { replyCode, replyText, exchange: entry.exchange, routingKey: entry.routingKey },
      properties: { messageId: entry.options.messageId, headers: entry.options.headers },
    });
  }

  deliver(queue, { content = Buffer.from(''), properties = {}, fields = {} } = {}) {
    const consumer = [...this.consumers.entries()].find(([, entry]) => entry.queue === queue);
    if (!consumer) throw new Error(`no consumer for ${queue}`);
    const [consumerTag, { callback }] = consumer;
    this.deliveryTag += 1;
    const message = {
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      fields: { deliveryTag: this.deliveryTag, redelivered: false, exchange: '', routingKey: queue, consumerTag, ...fields },
      properties: { headers: {}, ...properties },
    };
    Object.defineProperty(message, '__channel', { value: this, enumerable: false });
    callback(message);
    return message;
  }

  serverCancel(queue) {
    const consumer = [...this.consumers.entries()].find(([, entry]) => entry.queue === queue);
    if (!consumer) throw new Error(`no consumer for ${queue}`);
    this.consumers.delete(consumer[0]);
    consumer[1].callback(null);
  }

  serverClose(code, text) {
    if (this.closed) return;
    this.emit('error', closeError(code, text));
    this.toClosed();
  }

  toClosed() {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pendingConfirms.splice(0);
    for (const entry of pending) {
      if (entry.callback) entry.callback(new Error('channel closed'));
    }
    this.connection.channels.delete(this);
    this.emit('close');
  }
}

class FakeConnection extends EventEmitter {
  constructor(fake) {
    super();
    this.fake = fake;
    this.closed = false;
    this.channels = new Set();
  }

  async createChannel() {
    if (this.closed) throw new Error('Connection closed');
    const channel = new FakeChannel(this, { confirm: false });
    this.channels.add(channel);
    this.fake.channels.push(channel);
    return channel;
  }

  async createConfirmChannel() {
    if (this.closed) throw new Error('Connection closed');
    const channel = new FakeChannel(this, { confirm: true });
    this.channels.add(channel);
    this.fake.channels.push(channel);
    return channel;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const channel of [...this.channels]) channel.toClosed();
    this.emit('close');
  }

  /** Simulate a lost connection (e.g. killed in the management UI). */
  kill(message = 'CONNECTION_FORCED - Closed via management plugin') {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(`Connection closed: 320 (${message})`);
    for (const channel of [...this.channels]) channel.toClosed();
    this.emit('error', error);
    this.emit('close', error);
  }
}

function createFakeAmqp() {
  const fake = {
    connections: [],
    channels: [],
    log: [],
    missing: new Set(),
    failConnects: 0,
    confirmMode: 'auto',
    connectDelayMs: 0,
    consumeDelayMs: 0,
    connect: async () => {
      fake.connectAttempts += 1;
      if (fake.connectDelayMs) await new Promise((resolve) => setTimeout(resolve, fake.connectDelayMs));
      if (fake.failConnects > 0) {
        fake.failConnects -= 1;
        throw new Error('ECONNREFUSED');
      }
      const connection = new FakeConnection(fake);
      fake.connections.push(connection);
      return connection;
    },
    connectAttempts: 0,
    get connection() { return fake.connections[fake.connections.length - 1]; },
    openChannels() { return fake.channels.filter((channel) => !channel.closed); },
    get consumeChannel() { return fake.openChannels().find((channel) => !channel.confirm); },
    get publishChannel() { return fake.openChannels().find((channel) => channel.confirm); },
  };
  return fake;
}

module.exports = { createFakeAmqp };
