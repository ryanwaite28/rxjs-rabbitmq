# Changelog

## 3.0.0 (unreleased)

3.0 makes the client safe to run as a long-lived production consumer under a least-privilege
RabbitMQ user. It adds publisher confirms, bounded memory, subscriptions that survive reconnects,
graceful shutdown, and broker-side retry and dead-lettering. The library stays unopinionated. It
gives you the hooks and guarantees, and you build envelopes, retry tiers, and dead-letter
vocabulary on top.

### Breaking changes

- **Dependencies.** `amqplib` (`^2.4.0`) and `rxjs` (`^7.8.2`) are now **peer dependencies**, so
  your app supplies one copy of each. `uuid` was dropped in favor of `crypto.randomUUID()`.
  Node.js `>= 20` is required.
- **Streams no longer replay.** Per-type streams are plain `Subject`s instead of unbounded
  `ReplaySubject`s. Memory no longer grows with every message, and a late subscriber no longer
  receives (and possibly re-acks) old deliveries.
- **Consumption is lazy.** A queue is consumed only while something subscribes to it through
  `onQueue(q).handle()`, `handleDefault()`, `handleAll()`, `onEvent()`, `forQueue()`, or a config
  `callbackHandler`. Calling `onQueue(q)` alone no longer starts a consumer. Unsubscribing the last
  subscriber cancels the consumer. `onMessage` observes deliveries but does not start consumers.
- **Publishing returns promises.** `publishEvent()` and `sendMessage()` return `Promise<void>`.
  With `confirm: true` (the new default) they resolve on broker ack, and reject with:
  - `PublishNackedError` on a broker nack
  - `PublishReturnedError` when a `mandatory` message can't be routed
  - `PublishChannelClosedError` when the channel closes before the confirm (e.g. a 404 for a
    missing exchange)
  - `ClientNotReadyError` or `ClientClosedError` when the client can't publish

  **Handle the returned promise.** An unhandled rejection terminates Node.js.
- **No unbounded buffering before ready.** A publish waits at most `readyTimeoutMs` (default 10 s)
  for the client to become ready, then rejects.
- **`close()` drains and never reconnects.** It stops consuming, then waits up to `drainTimeoutMs`
  (default 10 s) for in-flight deliveries to be settled, handler promises to finish, and
  outstanding confirms to arrive. Only then does it close the channels and the connection.
  `closed` is terminal, so `init()` after `close()` rejects.
- **Unhandled deliveries are requeued.** A delivery that no subscriber, type stream, or callback
  takes is now `nack(requeue = true)` by default. In 2.x it stayed unacked forever and stalled
  prefetch. Configure this with `unhandledMessages: 'nack-requeue' | 'nack' | 'ack' | 'default'`.
  The legacy `autoAckUnhandledMessageTypes` and `pushUnhandledMessageTypesToDefaultHandler` flags
  still work and are deprecated. A delivery that reached a `forQueue()` or `handleAll()`
  subscriber now counts as handled, so `autoAck` no longer acks it underneath that subscriber.
- **`handle(type)` accepts any message type**, whether or not it is listed in
  `handleMessageTypes`. Queues with config `callbackHandler`s are consumed automatically once the
  client is ready.
- **Retry and dead-letter helpers copy before they ack.** `retryMessage()`, `deadLetter()` and
  `handleMessageError()` are deprecated in favor of `republish()`, and now return promises. They
  publish the copy (confirmed) first and then **ack** the original. In 2.x they nacked the
  original before the copy existed, and `nack(false)` could dead-letter it a second time through
  the queue's own DLX.
  - The default DLQ name is now `{consumed queue}.dlq`, not `{routing key}.dlq`.
  - In `handleMessageError()`, `retryQueue` no longer requires `retryDelayMs`, and
    `deadLetterExchange` now publishes to that exchange.
- **Separate consume and publish channels.** A failed publish (e.g. a 404) no longer kills
  consumers. `getChannel()` returns the consume channel or `null`. `getPublishChannel()` is new.
  `getConnection()` returns `ChannelModel | null`.
- **Exponential reconnect backoff.** The delay doubles from `retryDelay` up to `maxRetryDelay`
  (default 30 s), with jitter; 2.x used a fixed delay. `retryAttempts` bounds both the
  initial-connect retries and the number of consecutive recovery attempts (`0` retries forever).
  When recovery is exhausted, the client closes.
- **Fewer process crashes.** An auto-init failure in the constructor is now reported on `errors$`
  (`init-failed`) instead of as an unhandled rejection. A message that fails to deserialize is
  rejected without requeue and reported. If a callback handler (sync or async) fails and leaves its
  message unsettled, that message is nack-requeued and the error is reported.
- **Types.** `MapType` defaults to `unknown` instead of `any`. Logger arguments are `unknown[]`.
  Config `callbackHandler` payloads are now narrowed per `messageName`; in 2.x they were the union
  of all payloads.
- **Package layout.** The package now has an `exports` map with `dist/cjs` and `dist/esm`, so deep
  imports of `rxjs-rabbitmq/dist/*.js` no longer resolve.

### Added

- `topology: 'declare' | 'verify' | 'none'`. `'verify'` uses passive `checkQueue` and
  `checkExchange` only, and skips bindings, so it works with `configure: '^$'`. A missing resource
  fails `init()` with a `TopologyVerificationError` that names it.
- `confirm`, plus `mandatory` returns correlated by `messageId`, backpressure that waits for
  `drain`, and `publishChannelOptions`.
- `state` (getter) and `state$`: `idle → connecting → ready → reconnecting → closing → closed`.
- `errors$`: connection and channel errors and closes, server-side consumer cancels, recovery
  failures, uncorrelated returns, and handler and hook errors.
- `stopConsuming(queue?)` and `startConsuming(queue?)`. Both resolve when the broker confirms;
  `stopConsuming` stays in effect across reconnects until `startConsuming` is called.
- `close({ drainTimeoutMs })`.
- Channel-level resilience. Channel errors, channel closes, and server `basic.cancel` take the
  client out of `ready`. It recreates the channel with backoff and re-consumes every subscribed
  queue, and the same observers keep receiving.
- `event.republish({ exchange, routingKey, headers, properties })` and
  `client.republish(message, options)`. Each confirm-publishes a copy (same body, merged
  properties and headers, `mandatory` by default, `userId` dropped), then acks the original. On
  failure it nack-requeues the original and rejects.
- On delivery events: `event.queue` (the consumed queue), `event.consumerTag`, and
  `event.settled`. Acks and nacks are applied at most once, and stale deliveries from a closed
  channel are ignored instead of triggering a 406.
- `hooks.onPublish(properties, target)` and `hooks.onDeliver(event)`, e.g. for W3C `traceparent`
  propagation.
- Metrics: `publishConfirmed`, `publishNacked`, `publishReturned` and `channelRecreated`.
- Config options `socketOptions`, `connect`, and `connection_url` as an `Options.Connect` object.
  `queues`, `exchanges`, `bindings`, `retryAttempts` and `retryDelay` are now optional.
- Error classes: `RabbitMQClientError`, `ClientNotReadyError`, `ClientClosedError`,
  `TopologyVerificationError`, `PublishError`, `PublishNackedError`, `PublishReturnedError`,
  `PublishChannelClosedError` and `MessageAlreadySettledError`.
- Dual ESM/CJS packaging. The ESM entry wraps the CJS build, so both import styles share one
  module instance and `instanceof` checks work either way.
- The build uses TypeScript 5.9, and CI also checks against 6.0. Declarations type-check under
  `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- CI runs lint, type checks, unit tests on Node 20, 22 and 24, and integration tests on RabbitMQ 4
  via Testcontainers, including a restricted-user test, a reconnect test, a SIGKILL test and a
  100k-message memory test. Releases are published with npm provenance.

## 2.2.3

- Typed APIs and instance serializer support.
