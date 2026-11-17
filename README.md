# RxJS RabbitMQ Client

A lightweight RabbitMQ client for Node.js that blends RabbitMQ messaging with RxJS-style event handling.

The library is intentionally small and stable: it focuses on four primary tasks:

- establishing a RabbitMQ connection and channel
- asserting queues, exchanges, and bindings
- exposing queue events as RxJS streams
- supporting basic request/reply messaging and typed publish helpers

It is designed for service-to-service messaging where you want a simple and familiar RxJS interface without introducing a larger messaging framework.

## Why this library exists

This package is best when you want:

- RabbitMQ message handling with RxJS streams
- per-queue event subscriptions
- message type routing from `message.properties.type`
- simple request/reply patterns
- direct control over RabbitMQ resources without a heavy abstraction layer

It is not a full orchestration engine or a replacement for a full enterprise messaging platform. The library tries to stay small, explicit, and operationally predictable.

## Installation

```bash
npm install rxjs-rabbitmq amqplib rxjs uuid
```

## Core concepts

### Queue configuration

Each configured queue can optionally declare known message types:

```ts
const queues = [
  {
    name: 'emails',
    handleMessageTypes: ['SEND_EMAIL', 'EMAIL_SENT'],
    options: { durable: true }
  }
];
```

When a message arrives:

- the global `onMessage` stream receives it
- the queue-specific stream receives it
- if the message has a known `type`, it is routed to the matching registered stream or callback
- if no type is found, it is routed to the default queue handler when enabled

### Exchange configuration

```ts
const exchanges = [
  {
    name: 'user.events',
    type: 'fanout',
    options: { durable: true }
  }
];
```

### Binding configuration

```ts
const bindings = [
  {
    queue: 'emails',
    exchange: 'user.events',
    routingKey: '#'
  }
];
```

## Quick start

```ts
import { RabbitMQClient, RmqEventMessage, ContentTypes } from 'rxjs-rabbitmq';

const client = new RabbitMQClient({
  connection_url: process.env.RABBITMQ_URL!,
  retryAttempts: 3,
  retryDelay: 2000,
  prefetch: 10,
  autoAckUnhandledMessageTypes: true,
  queues: [
    {
      name: 'emails',
      handleMessageTypes: ['SEND_EMAIL'],
      options: { durable: true }
    }
  ],
  exchanges: [
    {
      name: 'app.events',
      type: 'fanout',
      options: { durable: true }
    }
  ],
  bindings: []
});

client.onMessage.subscribe((event: RmqEventMessage) => {
  console.log('Received message', event.data);
});

client.onQueue('emails').handle('SEND_EMAIL').subscribe({
  next: (event: RmqEventMessage) => {
    console.log('Email event payload:', event.data);
    event.ack();
  }
});
```

## Event handling patterns

### 1. Listen to every message on a queue

```ts
const queue$ = client.forQueue('emails');

queue$.subscribe({
  next: (event) => {
    console.log('event payload', event.data);
  }
});
```

### 2. Handle a specific message type

```ts
const emailsQueue = client.onQueue('emails');

emailsQueue.handle('SEND_EMAIL').subscribe({
  next: (event) => {
    console.log(event.data);
    event.ack();
  }
});
```

### 3. Use a callback-based event handler

```ts
const emailsQueue = client.onQueue('emails');

emailsQueue.onEvent('SEND_EMAIL', (event) => {
  console.log(event.data);
  event.ack();
});
```

### 4. Listen to all messages on a queue with a custom handler

```ts
client.onQueue('emails').handleAll((event) => {
  console.log(event.message.properties.type, event.data);
});
```

## Publishing messages

### Publish to a queue

```ts
client.sendMessage({
  queue: 'emails',
  data: { to: 'user@example.com', body: 'Hello' },
  publishOptions: {
    contentType: 'application/json',
    persistent: true
  }
});
```

### Publish to an exchange

```ts
client.publishEvent({
  exchange: 'app.events',
  routingKey: 'user.created',
  data: { id: '123', name: 'Ada' },
  publishOptions: {
    contentType: 'application/json',
    type: 'USER_CREATED',
    persistent: true
  }
});
```

## Request/reply pattern

```ts
const response = await client.sendRequest<{ ok: boolean }>({
  queue: 'worker',
  data: { action: 'generate-report' },
  publishOptions: {
    correlationId: 'req-123',
    contentType: 'application/json',
    type: 'GENERATE_REPORT'
  }
}, true, 30000);

console.log(response.data);
```

The request helper creates a temporary exclusive reply queue and watches for a matching correlation ID. If a reply is not received before the timeout, the promise rejects and the temporary consumer is cancelled.

## Message acknowledgement and recovery

The event object includes helper methods:

```ts
client.onQueue('emails').handle('SEND_EMAIL').subscribe({
  next: (event) => {
    // ack once business logic succeeds
    event.ack();

    // or reject and requeue if necessary
    client.nack(event.message, true);
  }
});
```

### Retry and dead-letter helpers

```ts
client.onQueue('emails').handle('SEND_EMAIL').subscribe({
  next: (event) => {
    try {
      // business logic
    } catch (error) {
      client.retryMessage(event.message, {
        delayMs: 1000,
        requeue: true,
        queue: 'emails.retry'
      });
    }
  }
});
```

```ts
client.deadLetter(event.message, 'processing failed', 'emails.dlq');
```

These helpers are intentionally opt-in and explicit; they avoid forcing a policy onto all consumers.

## Serialization

The library includes a built-in serializer registry in `SERIALIZERS` and supports custom registration.

```ts
import { registerSerializer } from 'rxjs-rabbitmq';

registerSerializer('application/custom', {
  serialize: (value) => Buffer.from(JSON.stringify(value)),
  deserialize: (buffer) => JSON.parse(buffer.toString('utf8'))
});
```

You can also call:

```ts
RabbitMQClient.registerSerializer('application/custom', {
  serialize: ...,
  deserialize: ...
});
```

## Metrics and observability

When `metrics: true` is enabled, the client tracks counts for:

- received messages
- published messages
- acked messages
- nacked messages
- retried messages
- RPC requests
- RPC responses
- reconnects

```ts
const client = new RabbitMQClient({
  connection_url: process.env.RABBITMQ_URL!,
  metrics: true,
  queues: [],
  exchanges: [],
  bindings: [],
  retryAttempts: 2,
  retryDelay: 1000
});

console.log(client.getMetrics());
```

This is useful for diagnostics and operational visibility, but it remains optional and should not be enabled unless you want the extra bookkeeping.

## Logger configuration

Logs are optional and fully configurable.

```ts
const client = new RabbitMQClient({
  connection_url: process.env.RABBITMQ_URL!,
  logger: {
    debug: (...args) => console.debug('[rabbitmq]', ...args),
    info: (...args) => console.info('[rabbitmq]', ...args),
    warn: (...args) => console.warn('[rabbitmq]', ...args),
    error: (...args) => console.error('[rabbitmq]', ...args)
  },
  queues: [],
  exchanges: [],
  bindings: [],
  retryAttempts: 3,
  retryDelay: 2000
});
```

This is especially helpful in production, where per-message logs can become a throughput bottleneck.

## Lifecycle management

The client exposes a manual close method for clean shutdown:

```ts
await client.close();
```

This clears any reconnect timer, closes the channel and connection, and marks the client as no longer ready.

## Full example

```ts
import {
  RabbitMQClient,
  RmqEventMessage,
  ContentTypes
} from 'rxjs-rabbitmq';

const client = new RabbitMQClient({
  connection_url: process.env.RABBITMQ_URL!,
  delayStart: 1500,
  prefetch: 25,
  retryAttempts: 3,
  retryDelay: 2000,
  rpcRequestTimeoutMs: 30000,
  metrics: true,
  autoAckUnhandledMessageTypes: true,
  logger: {
    info: (...args) => console.info('[rmq]', ...args),
    warn: (...args) => console.warn('[rmq]', ...args),
    error: (...args) => console.error('[rmq]', ...args)
  },
  queues: [
    {
      name: 'emails',
      handleMessageTypes: ['SEND_EMAIL', 'EMAIL_SENT'],
      options: { durable: true }
    }
  ],
  exchanges: [
    {
      name: 'app.events',
      type: 'fanout',
      options: { durable: true }
    }
  ],
  bindings: [
    {
      queue: 'emails',
      exchange: 'app.events',
      routingKey: '#'
    }
  ]
});

const emailsQueue = client.onQueue('emails');

emailsQueue.handle('SEND_EMAIL').subscribe({
  next: async (event: RmqEventMessage) => {
    try {
      const payload = event.data as { to: string; subject: string; html: string };
      console.log('Sending email', payload);
      event.ack();
      client.publishEvent({
        exchange: 'app.events',
        routingKey: 'email.sent',
        data: { ok: true, to: payload.to },
        publishOptions: {
          type: 'EMAIL_SENT',
          contentType: ContentTypes.JSON,
          persistent: true
        }
      });
    } catch (error) {
      client.deadLetter(event.message, 'email send failed', 'emails.dlq');
    }
  }
});

process.on('SIGINT', async () => {
  await client.close();
  process.exit(0);
});
```

## Design goals and trade-offs

This package intentionally favors simplicity over abstraction. It does not hide RabbitMQ details completely, and it does not force a specific application-level architecture. Instead, it gives you:

- a direct client
- RxJS streams
- explicit message acknowledgement
- configurable production defaults
- small extension points for serializers, retries, and metrics

That makes it easy to reason about and safe to use in microservice environments without introducing lots of hidden behavior.

## Stability guidance

The same library should remain stable if you follow a few rules:

- keep message types explicit
- prefer `ack()` only after successful processing
- use `nack()` and `retryMessage()` only when you own the retry strategy
- use `logger` and `metrics` as opt-in production controls
- do not rely on implicit routing behavior for critical workflows

## Contributing

This project is intentionally small. Improvements are most welcome when they:

- reduce operational risk
- improve RxJS ergonomics
- maintain a simple public API
- do not quietly introduce opinionated infrastructure behavior

## License

ISC

## Support

This package assumes you already understand RabbitMQ semantics and the application-level contract around your queues, exchanges, and routing keys.
