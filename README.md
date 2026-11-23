# RxJS RabbitMQ Client

A small RabbitMQ client for Node.js that exposes queues as RxJS streams. It is built for
long-running services: publisher confirms, bounded memory, subscriptions that survive reconnects,
graceful shutdown, and broker-side retry and dead-lettering. It runs under a least-privilege
RabbitMQ user.

It intentionally stays small and unopinionated. It gives you the hooks and guarantees, and you
build your envelope schema, retry tiers, idempotency and tracing on top.

> Upgrading from 2.x? See [CHANGELOG.md](./CHANGELOG.md). Publishing now returns promises,
> streams no longer replay, and `close()` drains and never reconnects.

## Installation

```bash
npm install rxjs-rabbitmq amqplib rxjs
```

`amqplib` (`^2.4.0`) and `rxjs` (`^7.8.2`) are peer dependencies, so your app supplies exactly one
copy of each. Node.js `>= 20`. The package ships CommonJS and ESM (`import` and `require` both
work, and share one module instance) with type declarations.

## Quick start

```ts
import { RabbitMQClient, ContentTypes } from 'rxjs-rabbitmq';

const client = new RabbitMQClient({
  connection_url: process.env.RABBITMQ_URL!,
  topology: 'verify',     // topology is declared out of band; only check it exists
  confirm: true,          // default: publishes resolve on broker ack
  prefetch: 16,
  queues: [{ name: 'emails' }],
  exchanges: [{ name: 'app.events', type: 'topic' }],
});

client.onQueue('emails').handle('SEND_EMAIL').subscribe(async (event) => {
  await sendEmail(event.data);
  event.ack();
});

await client.publishEvent({
  exchange: 'app.events',
  routingKey: 'email.requested',
  data: { to: 'user@example.com' },
  publishOptions: { type: 'SEND_EMAIL', contentType: ContentTypes.JSON, persistent: true, mandatory: true },
});
```

## Core concepts

### Topology modes

`topology` controls what the client does with `queues`, `exchanges` and `bindings` on every
(re)connect:

| Mode | Calls | Permission needed |
|---|---|---|
| `'declare'` (default) | `assertQueue`, `assertExchange`, `bindQueue` | `configure` |
| `'verify'` | passive `checkQueue`, `checkExchange`; bindings are skipped | none |
| `'none'` | nothing | none |

In `'verify'` mode, a missing queue or exchange fails `init()` with a `TopologyVerificationError`
that names it (`error.resourceType`, `error.resource`). It is not retried.

`onQueue(q)` works for **any** queue in your `QueueName` type, whether or not it is listed in
`queues`.

#### Least-privilege setup

The runtime user only needs `read` on the queues it consumes and `write` on the exchanges it
publishes to:

```bash
rabbitmqctl set_permissions -p / svc-orders '^$' '^orders\.events$' '^orders\.q$'
#                                   configure   write               read
```

```ts
new RabbitMQClient({
  connection_url: 'amqp://svc-orders:***@rabbitmq',
  topology: 'verify',
  queues: [{ name: 'orders.q' }],
  exchanges: [{ name: 'orders.events', type: 'topic' }],
});
```

Notes:
- `sendMessage()` publishes through the default exchange, which requires `write` on `amq.default`.
- `sendRequest()` declares an exclusive reply queue, which requires `configure`.
- RabbitMQ 4.x rejects transient (`durable: false`), non-exclusive queues.

### Message types

Messages are routed by `message.properties.type`:

- `onQueue(q).handle(type)` gets deliveries of that type
- `onQueue(q).handleDefault()` gets deliveries without a type
- `onQueue(q).handleAll(handler)` and `forQueue(q)` get every delivery on the queue
- `handleMessageTypes` callback entries in the queue config act as handlers registered up front

A delivery that reaches none of these is handled by `unhandledMessages`:

| Policy | Behavior |
|---|---|
| `'nack-requeue'` (default) | `nack(requeue = true)`; nothing is lost |
| `'nack'` | `nack(requeue = false)`, which dead-letters via the queue's DLX if it has one |
| `'ack'` | acknowledge and drop |
| `'default'` | push to `handleDefault()`; falls back to `'nack-requeue'` if nobody listens there |

### Lazy consumption and bounded streams

- A queue is consumed (`basic.consume`) only while something subscribes to it. Unsubscribing the
  last subscriber cancels the consumer, so deliveries are never pushed into a stream nobody
  listens to.
- Streams are plain `Subject`s. A late subscriber gets only new deliveries, never history.
- Streams are created once and **survive reconnects**. After a reconnect the client re-issues
  `basic.consume` for every queue that still has subscribers, and the same observers keep
  receiving.
- `client.onMessage` taps every delivery from every consumed queue. It does not start consumers.

Handle errors inside RxJS `subscribe` callbacks yourself; RxJS rethrows them asynchronously. The
`handleAll(handler)` and `onEvent(type, handler)` helpers, and config `callbackHandler`s, catch
sync and async errors for you. They report the error on `errors$` and nack-requeue the message if
it is still unsettled.

## Event handling patterns

```ts
// every delivery on a queue
client.forQueue('emails').subscribe((event) => { /* ... */ event.ack(); });

// one message type (RxJS)
client.onQueue('emails').handle('SEND_EMAIL').subscribe((event) => { /* ... */ event.ack(); });

// one message type (callback; returned promises are tracked for graceful shutdown)
client.onQueue('emails').onEvent('SEND_EMAIL', async (event) => { /* ... */ event.ack(); });

// every delivery (callback)
client.onQueue('emails').handleAll(async (event) => {
  console.log(event.queue, event.message.properties.type, event.data);
  event.ack();
});
```

Each delivery event carries:

- `data`: the deserialized body
- `message`: the amqplib `ConsumeMessage`
- `queue`: the queue it was consumed from (use this in logs, not `message.fields.routingKey`)
- `consumerTag`
- `settled`
- `ack()` and `nack(requeue = true)`, each applied at most once. Calling either on a delivery
  whose channel has since closed is a no-op, because the broker redelivers it.
- `republish(options)`, covered under [Broker-side retry and dead-lettering](#broker-side-retry-and-dead-lettering-confirm-then-ack)
- `publishEvent`, `sendMessage` and `sendRequest`

## Publishing

`publishEvent()` and `sendMessage()` return `Promise<void>`.

```ts
import { PublishNackedError, PublishReturnedError, PublishChannelClosedError } from 'rxjs-rabbitmq';

try {
  await client.publishEvent({
    exchange: 'app.events',
    routingKey: 'user.created',
    data: { id: '123' },
    publishOptions: { type: 'USER_CREATED', contentType: 'application/json', persistent: true, mandatory: true },
  });
  // the broker has the message
} catch (error) {
  if (error instanceof PublishReturnedError) { /* unroutable: error.replyCode, error.replyText */ }
  else if (error instanceof PublishNackedError) { /* broker refused it, e.g. a full queue with reject-publish */ }
  else if (error instanceof PublishChannelClosedError) { /* e.g. 404 missing exchange; error.cause has the broker error */ }
  else { /* ClientNotReadyError / ClientClosedError */ }
}
```

- With `confirm: true` (default), publishing uses a confirm channel. The promise resolves only
  after the broker acks the message, which makes it safe for a transactional outbox.
- With `mandatory: true`, an unroutable message rejects with `PublishReturnedError` instead of
  being silently dropped. When you don't set a `messageId`, one is generated for correlation.
- **Backpressure.** When amqplib's write buffer is full, publishes wait for `drain`. Tune this with
  `publishChannelOptions: { highWaterMark }`, which counts frames.
- **Before ready.** While the client isn't ready, publishes wait up to `readyTimeoutMs` (default
  10 s), then reject with `ClientNotReadyError`. Nothing is buffered without bound.
- **Separate channels.** Publishing uses its own channel, so a failed publish doesn't interrupt
  consumers. The publish channel is recreated automatically.
- **Unconfirmed mode.** With `confirm: false`, publishes resolve once the message is written to the
  socket buffer. Returns are then reported on `errors$` as `message-returned`.

Always handle the returned promise: an unhandled rejection terminates Node.js.

## Broker-side retry and dead-lettering (confirm-then-ack)

`event.republish()` confirm-publishes a copy of the delivery to an exchange, and **only then** acks
the original. If the publish fails, the original is nack-requeued and the promise rejects. If the
process dies at any point before the ack, the broker redelivers the original. The library never
sleeps; express delays with TTL queues you own.

The copy keeps the same body. Properties and headers are merged over the original's. `mandatory`
defaults to `true`, so an unbound retry route can't silently drop the copy. `userId` is dropped,
because the broker would refuse it on another user's connection.

```ts
client.onQueue('orders.q').handleAll(async (event) => {
  try {
    await processOrder(event.data);
    event.ack();
  } catch (error) {
    const attempt = Number(event.message.properties.headers?.['x-retry-count'] ?? 0);
    if (attempt < 3) {
      await event.republish({
        exchange: 'orders.retry',                       // routes to a TTL queue that dead-letters back
        routingKey: `${event.queue}.retry.${[1, 5, 30][attempt]}s`,
        headers: { 'x-retry-count': attempt + 1 },
      });
    } else {
      await event.republish({
        exchange: 'dlx',
        routingKey: event.queue,
        headers: { 'x-error': String(error) },
      });
    }
  }
});
```

The retry topology is yours. For example, `orders.q.retry.5s` is declared with
`x-message-ttl: 5000`, `x-dead-letter-exchange: ''` and
`x-dead-letter-routing-key: 'orders.q'`, and bound to `orders.retry`.

`client.republish(message, options)` does the same with a raw `ConsumeMessage`.

### Deprecated helpers

`retryMessage()`, `deadLetter()` and `handleMessageError()` still work and return promises. They
now publish the copy first and ack the original after it is confirmed; they never nack before the
copy exists. Their optional delays (`delayMs`, `retryDelayMs`) are waited in-process with the
original still unacked, which is crash-safe but holds a prefetch slot. Prefer `republish()` with
TTL queues.

`setupDeadLetterQueue()` declares a DLX/DLQ pair and requires `configure` permission.

## Lifecycle, readiness and shutdown

```ts
client.state;            // 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closing' | 'closed'
client.state$.subscribe((state) => metrics.gauge('rabbitmq_state', state));
client.errors$.subscribe((event) => logger.warn({ event }, 'rabbitmq'));

// readiness probe: connected, both channels open, every subscribed queue being consumed
app.get('/ready', (_req, res) => res.sendStatus(client.state === 'ready' ? 200 : 503));

process.once('SIGTERM', async () => {
  await client.close({ drainTimeoutMs: 20_000 });
  process.exit(0);
});
```

- `ready` means the connection and both channels are open and every queue with subscribers (and
  not stopped) has an active consumer. Any connection failure, channel failure (404/406/403), or
  server-side `basic.cancel` (e.g. the queue was deleted) moves the client to `reconnecting` and
  emits on `errors$`. The client then recreates whatever is missing, with exponential backoff
  (`retryDelay` doubling up to `maxRetryDelay`).
- `retryAttempts` bounds the initial-connect retries and the number of consecutive recovery
  attempts. `0` means no initial retry and unlimited recovery.
- `stopConsuming(queue?)` cancels consumers and resolves when the broker confirms. It stays in
  effect across reconnects until `startConsuming(queue?)`.
- `close({ drainTimeoutMs })` (default `drainTimeoutMs` 10 s) works in this order:
  1. Cancel all consumers.
  2. Wait for in-flight deliveries to be acked, nacked or republished, and for promises returned
     by `handleAll`, `onEvent` or callback handlers to settle.
  3. Wait for outstanding publisher confirms.
  4. Close the channels and the connection.

  Handlers can still ack and publish while draining. **No reconnect is ever scheduled from
  `closing` or `closed`.**

`errors$` event types:

| Event | Meaning |
|---|---|
| `connection-error`, `connection-closed` | Connection failed or closed |
| `channel-error`, `channel-closed` | `channel` is `'consume'` or `'publish'` |
| `consumer-cancelled` | The broker sent `basic.cancel` for a consumer |
| `init-failed` | Automatic `init()` from the constructor failed |
| `recovery-failed`, `recovery-exhausted` | A recovery attempt failed, or attempts ran out |
| `message-returned` | Uncorrelated return (unconfirmed mode) |
| `handler-error` | A callback handler failed, or a message could not be deserialized |
| `hook-error` | An `onPublish` or `onDeliver` hook threw |

## Observability

### Hooks

Hooks let you inject and extract trace context (e.g. W3C `traceparent`) without the library
depending on OpenTelemetry:

```ts
new RabbitMQClient({
  // ...
  hooks: {
    onPublish: (properties, { exchange, routingKey }) => {
      properties.headers.traceparent = currentTraceparent(); // headers is always present
    },
    onDeliver: (event) => {
      startSpanFrom(event.message.properties.headers?.traceparent, { queue: event.queue });
    },
  },
});
```

Hooks run synchronously. A throwing hook is reported on `errors$` and doesn't fail the publish or
the delivery.

### Metrics

With `metrics: true`, `client.getMetrics()` returns the following counters:

- `messagesReceived`, `messagesPublished`, `messagesAcked`, `messagesNacked`, `messagesRetried`
- `rpcRequests`, `rpcResponses`
- `reconnects`, `channelRecreated`
- `publishConfirmed`, `publishNacked`, `publishReturned`

### Logger

```ts
logger: {
  debug: (...args) => log.debug(args),
  info: (...args) => log.info(args),
  warn: (...args) => log.warn(args),
  error: (...args) => log.error(args),
}
```

## Request/reply

```ts
const response = await client.sendRequest<{ ok: boolean }>({
  queue: 'worker',
  data: { action: 'generate-report' },
  publishOptions: { contentType: 'application/json', type: 'GENERATE_REPORT' },
}, true, 30000);
```

The request is sent with a confirm, and the reply is awaited on a temporary exclusive queue. If no
reply arrives before the timeout, the promise rejects.

## Serialization

Incoming messages are deserialized by `message.properties.contentType`, falling back to
`defaultContentType`. Outgoing data is serialized by `publishOptions.contentType`. Built-in
serializers cover `application/json`, `text/plain` and `application/octet-stream`. Instance
serializers take precedence over the global registry.

```ts
new RabbitMQClient({
  // ...
  defaultContentType: 'application/custom+json',
  serializers: {
    'application/custom+json': {
      serialize: (value) => Buffer.from(JSON.stringify(value)),
      deserialize: (buffer) => JSON.parse(buffer.toString('utf8')),
    },
  },
});

registerSerializer('application/custom', { serialize, deserialize });            // global
RabbitMQClient.registerSerializer('application/custom', { serialize, deserialize });
```

A message that fails to deserialize is rejected without requeue (it dead-letters if the queue has
a DLX) and reported on `errors$`.

## Compile-time resource and payload typing

```ts
type EmailPayloads = {
  SEND_EMAIL: { to: string; subject: string };
  EMAIL_SENT: { ok: boolean };
};

const client = new RabbitMQClient<
  'emails' | 'jobs',                              // QueueName
  'app.events' | 'app.retry',                     // ExchangeName
  '#' | 'email.sent' | `${string}.retry.${string}`, // RoutingKey
  'SEND_EMAIL' | 'EMAIL_SENT',                    // MessageName
  EmailPayloads                                   // TPayloadMap
>({
  connection_url: process.env.RABBITMQ_URL!,
  queues: [{
    name: 'emails',
    handleMessageTypes: [{
      messageName: 'SEND_EMAIL',
      callbackHandler: (event) => { const to: string = event.data.to; },  // narrowed per messageName
    }],
  }],
});

client.onQueue('emails').handle('SEND_EMAIL').subscribe((event) => {
  const recipient: string = event.data.to;
});

// Compile-time errors:
// client.onQueue('unknown');
// client.onQueue('emails').handle('UNKNOWN_EVENT');
// client.publishEvent({ exchange: 'unknown.exchange', data: {}, publishOptions: {} });
```

All generics default to `string` or `unknown`. The declarations type-check under `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`
(TypeScript 5.9 and 6.0).

## Configuration reference

| Option | Default | |
|---|---|---|
| `connection_url` | required | URL string or amqplib `Options.Connect` |
| `socketOptions` | | Passed to `amqplib.connect` (TLS, `clientProperties.connection_name`) |
| `topology` | `'declare'` | `'declare' \| 'verify' \| 'none'` |
| `confirm` | `true` | Use a confirm channel for publishing |
| `prefetch` | | `basic.qos` on the consume channel |
| `readyTimeoutMs` | `10000` | How long a publish waits for readiness |
| `drainTimeoutMs` | `10000` | Default for `close()` |
| `retryAttempts` | `0` | Initial retries; maximum consecutive recovery attempts (`0` retries forever) |
| `retryDelay` / `maxRetryDelay` | `1000` / `30000` | Exponential backoff bounds |
| `unhandledMessages` | `'nack-requeue'` | See [Message types](#message-types) |
| `hooks` | | `onPublish`, `onDeliver` |
| `publishChannelOptions` | | e.g. `{ highWaterMark }` |
| `metrics`, `logger`, `serializers`, `defaultContentType` | | |
| `queues` / `exchanges` / `bindings` | `[]` | Topology used by `'declare'` and `'verify'` |
| `stopAutoInit` | `false` | Call `init()` yourself |
| `delayStart`, `pre_init_promises`, `post_init_promises`, `rpcRequestTimeoutMs` | | |
| `connect` | `amqplib.connect` | Replace the connect function (tests, custom transports) |

## Development

```bash
npm run lint               # Biome
npm run typecheck          # TS 5.9: library + strict CJS/ESM consumer projects
npm run typecheck:ts6      # same with TypeScript 6.0
npm test                   # build + unit tests + ESM smoke test
npm run test:integration   # RabbitMQ 4 via Testcontainers (Docker required)
npm run test:slow          # 100k-message memory test
```

Integration tests start `rabbitmq:4-management` with Testcontainers. To use an existing broker
instead, set `RABBITMQ_AMQP_URL` and `RABBITMQ_MGMT_URL` with admin credentials in both.

## License

ISC
