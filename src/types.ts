import type {
  ChannelModel,
  ChannelOptions,
  ConsumeMessage,
  Message,
  Options,
  SocketOptions,
} from "amqplib";

export type MapType<T = unknown> = { [key: string]: T };

export type RmqPayloadMap = Record<string, unknown>;
export type RmqMessageTypeHandler<TPayload = unknown, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = (event: RmqEventMessage<TPayload, QueueName, ExchangeName, RoutingKey>) => Promise<void> | void;
export type RmqHandleMessageTypeConfig<MessageName extends string = string, TPayload = unknown, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = {
  messageName: MessageName,
  callbackHandler: RmqMessageTypeHandler<TPayload, QueueName, ExchangeName, RoutingKey>
};
export type RmqHandleMessageTypeConfigs<MessageName extends string = string, TPayloadMap extends RmqPayloadMap = RmqPayloadMap, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> =
  readonly (MessageName | { [K in MessageName]: RmqHandleMessageTypeConfig<K, TPayloadMap[K], QueueName, ExchangeName, RoutingKey> }[MessageName])[];
export type ExchangeType = 'direct' | 'topic' | 'headers' | 'fanout';
export type RmqPayload = unknown;

/**
  Lifecycle states of the client.

  - `idle`: constructed, `init()` not called yet (or the last `init()` failed)
  - `connecting`: first connection attempt in progress
  - `ready`: connection and both channels are open, and every queue with subscribers is being consumed
  - `reconnecting`: something failed (connection, channel, or a server-side consumer cancel); recovery is scheduled or running
  - `closing`: `close()` was called; consumers are cancelled and in-flight work is draining
  - `closed`: terminal. No reconnect is ever scheduled from `closing` or `closed`.
*/
export type ClientState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closing' | 'closed';

/**
  How the client treats the configured `queues`, `exchanges` and `bindings` on each (re)connect.

  - `declare`: `assertQueue` / `assertExchange` / `bindQueue` (requires `configure` permission)
  - `verify`: passive `checkQueue` / `checkExchange` only; bindings are skipped. Init fails with a
    `TopologyVerificationError` naming the first missing resource. Works with `configure: '^$'`.
  - `none`: touch nothing; the topology is owned by someone else.
*/
export type TopologyMode = 'declare' | 'verify' | 'none';

/**
  What to do with a delivery that reached no subscriber, type stream, or callback.

  - `nack-requeue`: `basic.nack(requeue = true)` (default; nothing is lost)
  - `nack`: `basic.nack(requeue = false)` (dead-letters it if the queue has a DLX, otherwise drops it)
  - `ack`: acknowledge and drop it
  - `default`: push it to the queue's default stream (`handleDefault()`); falls back to `nack-requeue` if nobody listens there
*/
export type UnhandledMessagePolicy = 'nack-requeue' | 'nack' | 'ack' | 'default';

export type RmqChannelRole = 'consume' | 'publish';

/**
  Events emitted on `client.errors$`. The stream never errors or completes before `close()`.
*/
export type RmqClientErrorEvent =
  | { type: 'connection-error', error: Error }
  | { type: 'connection-closed', error: Error | undefined }
  | { type: 'channel-error', channel: RmqChannelRole, error: Error }
  | { type: 'channel-closed', channel: RmqChannelRole, error: Error | undefined }
  /** The broker cancelled a consumer (`basic.cancel`), e.g. because the queue was deleted. */
  | { type: 'consumer-cancelled', queue: string, consumerTag: string }
  | { type: 'init-failed', error: unknown }
  | { type: 'recovery-failed', attempt: number, error: unknown }
  | { type: 'recovery-exhausted', attempts: number }
  /** A `mandatory` message was returned and no pending confirm-publish could be correlated with it. */
  | { type: 'message-returned', exchange: string, routingKey: string, replyCode: number, replyText: string, messageId: string | undefined }
  /** A callback handler (`callbackHandler`, `onEvent`, `handleAll`) threw or rejected. */
  | { type: 'handler-error', queue: string, messageType: string | undefined, error: unknown }
  | { type: 'hook-error', hook: 'onPublish' | 'onDeliver', error: unknown };


export interface QueueConfig<
  QueueName extends string = string,
  MessageName extends string = string,
  TPayloadMap extends RmqPayloadMap = RmqPayloadMap
> {
  /**
    The name of the queue you want to consume messages from
  */
  name: QueueName,

  /**
    The events to handle on the queue via the message.properties.type value.
    This event name approach is a custom logic, not an official use or convention of message brokers.
    For example, there could be a `USERS` queue with messages of different events
    such as `DELETE_USER` or `CREATE_USER`.

    String entries are optional documentation: `onQueue(q).handle(type)` works for any message type.
    Callback entries register a handler; a queue with callback handlers is consumed as soon as the client is ready.
  */
  handleMessageTypes?: RmqHandleMessageTypeConfigs<MessageName, TPayloadMap, QueueName, string, string>,

  /**
    Options for `assertQueue` (only used with `topology: 'declare'`)
  */
  options?: Options.AssertQueue
}


/**
  The exchange config.
  An exchange is the means of delivering a message from a producer to a queue for consumers.
  In other words, the post man that delivers mail.

  This is usually defined for a producer to publish event messages
  and how queues are allowed to receive messages from the exchange (based on the exchange type).
*/
export interface ExchangeConfig<ExchangeName extends string = string> {
  /**
    The name of the exchange
  */
  name: ExchangeName,

  /**
    The exchange type.

    - `direct`: deliver to queue(s) based on EXACT matching routing key
    - `topic`: deliver to queue(s) based on PATTERN matching routing key
    - `headers`: deliver to queue(s) based on HEADERS
    - `fanout`: deliver to all bound queues
  */
  type: ExchangeType,

  /**
    Options for `assertExchange` (only used with `topology: 'declare'`)
  */
  options?: Options.AssertExchange
}


/**
  The exchange to queue binding.
  This config determines what queues an exchange will forward messages to.

  It is usually defined for a consumer to request messages from an exchange to a queue they are consuming/listening on.
  Only applied with `topology: 'declare'`.
*/
export interface QueueExchangeBindingConfig<
  QueueName extends string = string,
  ExchangeName extends string = string,
  RoutingKey extends string = string
> {
  /**
    The queue for the consumer to receive messages in
  */
  queue: QueueName,

  /**
    The exchange for the consumer to request messages from
  */
  exchange: ExchangeName,

  /**
    The key for the consumer to filter the messages on
  */
  routingKey: RoutingKey
}

export type DeadLetterQueueConfig = {
  sourceQueue: string,
  deadLetterQueue?: string,
  deadLetterExchange?: string,
  deadLetterRoutingKey?: string,
  queueOptions?: Options.AssertQueue,
  deadLetterQueueOptions?: Options.AssertQueue,
  maxLength?: number,
  messageTtlMs?: number,
};

export type HandleMessageErrorOptions = {
  reason?: string,
  /** Used only when no retry/dead-letter target is given: `nack(requeue)`. */
  requeue?: boolean,
  deadLetterQueue?: string,
  /** Publish the dead letter to this exchange (e.g. a topic DLX) instead of a queue. */
  deadLetterExchange?: string,
  /** Routing key for `deadLetterExchange` (defaults to the source queue name). */
  deadLetterRoutingKey?: string,
  retryQueue?: string,
  /** @deprecated in-process delays are not crash-safe; use broker TTL queues with `event.republish()`. */
  retryDelayMs?: number,
  loggerMessage?: string,
};

export type RmqMessageErrorOutcome =
  | { action: 'retry', targetQueue: string, retryDelayMs: number }
  | { action: 'dead-letter', targetQueue: string }
  | { action: 'dead-letter', targetExchange: string, routingKey: string }
  | { action: 'nack', requeue: boolean };

export type RmqEventRequestResponse<T = unknown> = Promise<RmqEventMessage<T>>;

export type RmqSendMessageParams<
  T = unknown,
  QueueName extends string = string
> = {
  queue: QueueName,
  data: T,
  publishOptions: Options.Publish
}

export type RmqSendRequestParams<
  T = unknown,
  QueueName extends string = string
> = {
  queue: QueueName,
  data: T,
  publishOptions: Options.Publish,
}

export type RmqPublishEventParams<
  T = unknown,
  ExchangeName extends string = string,
  RoutingKey extends string = string
> = {
  exchange: ExchangeName,
  data: T,
  routingKey?: RoutingKey,
  publishOptions: Options.Publish
}

/** @deprecated use `event.republish()` with broker-side TTL retry queues. */
export type RmqRetryMessageOptions<QueueName extends string = string> = {
  /** @deprecated in-process delays are not crash-safe; the original stays unacked while waiting. */
  delayMs?: number,
  /** Only used when there is no target queue: `nack(requeue)`. */
  requeue?: boolean,
  queue?: QueueName,
};

/**
  Options for `event.republish()`: confirm-publish a copy of the delivery, then ack the original.
*/
export type RmqRepublishOptions<
  ExchangeName extends string = string,
  RoutingKey extends string = string
> = {
  exchange: ExchangeName,
  routingKey: RoutingKey,
  /** Merged over the original headers (and over `properties.headers`). */
  headers?: Record<string, unknown>,
  /**
    Merged over the original message properties. `mandatory` defaults to `true` so an unroutable
    copy rejects (and the original is nack-requeued) instead of being dropped.
  */
  properties?: Options.Publish,
};

/**
  A single delivery, as handed to subscribers and handlers.
*/
export type RmqEventMessage<
  T = unknown,
  QueueName extends string = string,
  ExchangeName extends string = string,
  RoutingKey extends string = string
> = {
  data: T,
  message: ConsumeMessage,
  /** The queue this delivery was consumed from (unlike `message.fields.routingKey`). */
  queue: QueueName,
  consumerTag: string,
  /** `true` once the delivery was acked, nacked, republished, or its channel closed. */
  readonly settled: boolean,
  ack: () => void;
  nack: (requeue?: boolean) => void,
  /**
    Confirm-publish a copy (same body, merged properties and headers) to `exchange`, THEN ack the original.
    If the publish fails, the original is nacked with `requeue = true` and the promise rejects.
    The library never sleeps: express delays with broker TTL queues.
  */
  republish: (options: RmqRepublishOptions<ExchangeName, RoutingKey>) => Promise<void>,
  /** @deprecated use `republish()` */
  retry: (options?: RmqRetryMessageOptions<QueueName>) => Promise<void>,
  handlerError: (
    error: unknown,
    options?: HandleMessageErrorOptions
  ) => Promise<RmqMessageErrorOutcome>,
  publishEvent: <P = unknown>(options: RmqPublishEventParams<P, ExchangeName, RoutingKey>) => Promise<void>,
  sendMessage: <U = unknown>(options: RmqSendMessageParams<U, QueueName>) => Promise<void>,
  sendRequest: <U = unknown>(options: RmqSendRequestParams<unknown, QueueName>) => Promise<RmqEventMessage<U, QueueName, ExchangeName, RoutingKey>>,
};

export type RmqEventHandler<TPayload = unknown, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = (event: RmqEventMessage<TPayload, QueueName, ExchangeName, RoutingKey>) => unknown;

export type AckFn = (message: Message) => void;

export type RabbitMqLogger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type RabbitMqMetrics = {
  messagesReceived: number;
  messagesPublished: number;
  messagesAcked: number;
  messagesNacked: number;
  messagesRetried: number;
  rpcRequests: number;
  rpcResponses: number;
  reconnects: number;
  publishConfirmed: number;
  publishNacked: number;
  publishReturned: number;
  channelRecreated: number;
};

export type RabbitMqSerializer = {
  serialize: (value: unknown) => Buffer;
  deserialize: (value: Buffer, encoding?: BufferEncoding) => unknown;
};

export type RabbitMqSerializerMap = Record<string, RabbitMqSerializer>;

/** Publish properties as seen by the `onPublish` hook; `headers` is always present and mutable. */
export type RmqPublishProperties = Options.Publish & { headers: Record<string, unknown> };

export type RmqPublishTarget = { exchange: string, routingKey: string };

/**
  Instrumentation hooks, e.g. to inject/extract W3C `traceparent` headers without
  the library depending on OpenTelemetry. Hooks run synchronously; a throwing hook is
  reported on `errors$` and does not fail the publish or delivery.
*/
export type RmqHooks<
  QueueName extends string = string,
  ExchangeName extends string = string,
  RoutingKey extends string = string
> = {
  /** Called right before every publish (including republish/RPC). Mutate `properties.headers` to inject headers. */
  onPublish?: (properties: RmqPublishProperties, target: RmqPublishTarget) => void,
  /** Called for every delivery before it is dispatched to subscribers. */
  onDeliver?: (event: RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>) => void,
};

export type RmqCloseOptions = {
  /**
    Maximum time to wait for in-flight deliveries to be settled (acked/nacked/republished),
    for handler promises to settle, and for outstanding publisher confirms. Default: `config.drainTimeoutMs` (10 000 ms).
  */
  drainTimeoutMs?: number,
};

export type RmqConnectFn = (url: string | Options.Connect, socketOptions?: SocketOptions) => Promise<ChannelModel>;

/**

*/
export type RabbitMqInitConfig<
  QueueName extends string = string,
  ExchangeName extends string = string,
  RoutingKey extends string = string,
  MessageName extends string = string,
  TPayloadMap extends RmqPayloadMap = RmqPayloadMap
> = {
  /**
    Stop the constructor from automatically initializing the setup process.
    Allows for manually initializing later.
  */
  stopAutoInit?: boolean,
  dontSendToReplyQueueOnPublish?: boolean,
  /** @deprecated use `unhandledMessages: 'ack'` */
  autoAckUnhandledMessageTypes?: boolean,
  /** @deprecated use `unhandledMessages: 'default'` */
  pushUnhandledMessageTypesToDefaultHandler?: boolean,
  /** What to do with deliveries no subscriber or handler took. Default: `'nack-requeue'`. */
  unhandledMessages?: UnhandledMessagePolicy,
  logger?: Partial<RabbitMqLogger>,
  metrics?: boolean,
  hooks?: RmqHooks<QueueName, ExchangeName, RoutingKey>,
  rpcRequestTimeoutMs?: number,
  serializers?: RabbitMqSerializerMap,
  defaultContentType?: string,
  delayStart?: number,
  connection_url: string | Options.Connect,
  /** Passed to `amqplib.connect` (TLS options, `clientProperties.connection_name`, ...). */
  socketOptions?: SocketOptions,
  /** Options for the publish channel, e.g. `{ highWaterMark }` (in frames; amqplib default 1024) to tune when backpressure kicks in. */
  publishChannelOptions?: ChannelOptions,
  /**
    Replace `amqplib.connect` (testing, custom transports).
  */
  connect?: RmqConnectFn,
  /** Topology handling on each (re)connect. Default: `'declare'`. */
  topology?: TopologyMode,
  /**
    Use a confirm channel for publishing: `publishEvent`/`sendMessage` resolve on broker ack and reject on
    nack/return/channel close. Default: `true`. With `false` they resolve once the message is written
    to the socket buffer (after waiting for `drain` under backpressure).
  */
  confirm?: boolean,
  /**
    How long a publish waits for the client to become ready before rejecting with `ClientNotReadyError`.
    `0` rejects immediately. Default: 10 000 ms.
  */
  readyTimeoutMs?: number,
  /** Default drain timeout for `close()`. Default: 10 000 ms. */
  drainTimeoutMs?: number,
  /**
    Initial-connect retries (0 = fail on first error). After the first successful connection, the
    maximum number of consecutive recovery attempts (0 = retry forever). Default: 0.
  */
  retryAttempts?: number,
  /** Base delay for (re)connect attempts; doubles per consecutive failure up to `maxRetryDelay`. Default: 1000 ms. */
  retryDelay?: number,
  /** Upper bound for the exponential backoff. Default: 30 000 ms. */
  maxRetryDelay?: number,
  prefetch?: number,
  queues?: Array<QueueConfig<QueueName, MessageName, TPayloadMap>>,
  exchanges?: Array<ExchangeConfig<ExchangeName>>,
  bindings?: Array<QueueExchangeBindingConfig<QueueName, ExchangeName, RoutingKey>>,
  pre_init_promises?: (Promise<unknown> | (() => Promise<unknown>))[],
  post_init_promises?: (Promise<unknown> | (() => Promise<unknown>))[],
};
