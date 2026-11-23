import { randomUUID } from "node:crypto";

import { connect as amqpConnect } from "amqplib";
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Message,
  Options,
} from "amqplib";

import {
  BehaviorSubject,
  filter,
  firstValueFrom,
  map,
  Observable,
  Subject,
  type Subscription,
  take,
  timeout,
  TimeoutError,
} from "rxjs";

import {
  getSerializer,
  registerSerializer,
  SERIALIZERS,
  wait,
} from "./utils";

import type {
  ClientState,
  DeadLetterQueueConfig,
  HandleMessageErrorOptions,
  RabbitMqInitConfig,
  RabbitMqLogger,
  RabbitMqMetrics,
  RabbitMqSerializer,
  RabbitMqSerializerMap,
  RmqChannelRole,
  RmqClientErrorEvent,
  RmqCloseOptions,
  RmqConnectFn,
  RmqEventHandler,
  RmqEventMessage,
  RmqHandleMessageTypeConfig,
  RmqMessageErrorOutcome,
  RmqPayloadMap,
  RmqPublishEventParams,
  RmqPublishProperties,
  RmqRepublishOptions,
  RmqRetryMessageOptions,
  RmqSendMessageParams,
  RmqSendRequestParams,
  TopologyMode,
  UnhandledMessagePolicy,
} from "./types";

import {
  ClientClosedError,
  ClientNotReadyError,
  MessageAlreadySettledError,
  PublishChannelClosedError,
  PublishNackedError,
  PublishReturnedError,
  RabbitMQClientError,
  TopologyVerificationError,
} from "./errors";

import { ContentTypes } from "./enums";


export type RmgOnEventHandler = (event: RmqEventMessage, rmqClient?: RabbitMQClient) => void;

type AnyEvent<Q extends string, E extends string, R extends string> = RmqEventMessage<unknown, Q, E, R>;
type SettleAction = 'ack' | 'requeue' | 'reject';

/** Tracks one delivery from receipt until it is acked/nacked (or its channel dies). */
interface DeliveryRecord {
  readonly message: ConsumeMessage;
  readonly channel: Channel;
  readonly queue: string;
  readonly noAck: boolean;
  settled: boolean;
  /** A republish (copy-then-ack) is in progress. */
  settling: boolean;
}

/** Long-lived per-queue state. Subjects are created once and survive reconnects. */
interface QueueRuntime<TEvent> {
  readonly name: string;
  consumeOptions: Options.Consume | undefined;
  readonly all: Subject<TEvent>;
  readonly byType: Map<string, Subject<TEvent>>;
  readonly fallback: Subject<TEvent>;
  readonly callbacks: Map<string, (event: TEvent) => unknown>;
  /** Active subscriptions created through `onQueue()` / `forQueue()`. */
  listeners: number;
  /** Set by `stopConsuming()`; sticky across reconnects until `startConsuming()`. */
  paused: boolean;
  consumerTag: string | undefined;
  consumerChannel: Channel | undefined;
  starting: Promise<void> | undefined;
  stopping: Promise<void> | undefined;
}

interface PendingPublish {
  readonly exchange: string;
  readonly routingKey: string;
  readonly messageId: string | undefined;
  returned: { replyCode: number, replyText: string } | undefined;
}

const COPIED_PROPERTIES = [
  'contentType',
  'contentEncoding',
  'deliveryMode',
  'priority',
  'correlationId',
  'replyTo',
  'expiration',
  'messageId',
  'timestamp',
  'type',
  'appId',
] as const;

/**
  Build publish options for a copy of `message`. `userId` is dropped on purpose: the broker
  validates it against the publishing connection's user and would close the channel.
*/
function copyMessageProperties(message: Message, overrides?: Options.Publish, headers?: Record<string, unknown>): Options.Publish {
  const source = message.properties;
  const copy: Record<string, unknown> = {};
  for (const key of COPIED_PROPERTIES) {
    const value: unknown = source[key];
    if (value !== undefined && value !== null) {
      copy[key] = value;
    }
  }
  const merged: Options.Publish = { ...copy, ...(overrides ?? {}) };
  merged.headers = {
    ...(source.headers ?? {}),
    ...((overrides?.headers as Record<string, unknown> | undefined) ?? {}),
    ...(headers ?? {}),
  };
  return merged;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function noop() {
  return undefined;
}

/**
  Rabbit MQ - RxJS Powered
*/
export class RabbitMQClient<
  QueueName extends string = string,
  ExchangeName extends string = string,
  RoutingKey extends string = string,
  MessageName extends string = string,
  TPayloadMap extends RmqPayloadMap = RmqPayloadMap
> {
  private readonly clientInitConfig: RabbitMqInitConfig<QueueName, ExchangeName, RoutingKey, MessageName, TPayloadMap>;
  private readonly logger: RabbitMqLogger;
  private readonly serializers: RabbitMqSerializerMap;
  private readonly metricsEnabled: boolean;
  private readonly connectFn: RmqConnectFn;
  private readonly topologyMode: TopologyMode;
  private readonly confirmMode: boolean;
  private readonly unhandledPolicy: UnhandledMessagePolicy;
  private readonly metrics: RabbitMqMetrics = {
    messagesReceived: 0,
    messagesPublished: 0,
    messagesAcked: 0,
    messagesNacked: 0,
    messagesRetried: 0,
    rpcRequests: 0,
    rpcResponses: 0,
    reconnects: 0,
    publishConfirmed: 0,
    publishNacked: 0,
    publishReturned: 0,
    channelRecreated: 0,
  };

  private readonly stateSubject = new BehaviorSubject<ClientState>('idle');
  private readonly errorsSubject = new Subject<RmqClientErrorEvent>();
  private readonly connectionErrorStream = new Subject<Error>();
  private readonly connectionCloseStream = new Subject<Error | undefined>();
  /** Taps every delivery from every consumed queue. Does not start consumers by itself. */
  private readonly messagesStream = new Subject<AnyEvent<QueueName, ExchangeName, RoutingKey>>();

  private connection: ChannelModel | null = null;
  private consumeChannel: Channel | null = null;
  private publishChannel: Channel | ConfirmChannel | null = null;
  private readonly deadChannels = new WeakSet<Channel>();
  private readonly channelErrors = new WeakMap<Channel, Error>();

  private readonly queueRuntimes = new Map<string, QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>>();
  private readonly deliveries = new WeakMap<Message, DeliveryRecord>();
  private readonly inFlight = new Set<DeliveryRecord>();
  private readonly handlerPromises = new Set<Promise<unknown>>();
  private readonly pendingPublishes = new Set<PendingPublish>();
  private readonly pendingByMessageId = new Map<string, PendingPublish[]>();
  private drainPromise: Promise<void> | undefined;

  private initPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private establishPromise: Promise<void> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryAttempt = 0;
  private everReady = false;

  constructor(clientInitConfig: RabbitMqInitConfig<QueueName, ExchangeName, RoutingKey, MessageName, TPayloadMap>) {
    this.clientInitConfig = clientInitConfig;
    this.serializers = { ...(clientInitConfig.serializers || {}) };
    this.metricsEnabled = !!clientInitConfig.metrics;
    this.topologyMode = clientInitConfig.topology ?? 'declare';
    this.confirmMode = clientInitConfig.confirm ?? true;
    this.unhandledPolicy = clientInitConfig.unhandledMessages
      ?? (clientInitConfig.autoAckUnhandledMessageTypes ? 'ack'
        : clientInitConfig.pushUnhandledMessageTypesToDefaultHandler ? 'default'
        : 'nack-requeue');
    this.connectFn = clientInitConfig.connect ?? ((url, socketOptions) => amqpConnect(url, socketOptions));
    this.logger = {
      debug: clientInitConfig.logger?.debug ?? (() => undefined),
      info: clientInitConfig.logger?.info ?? console.info.bind(console),
      warn: clientInitConfig.logger?.warn ?? console.warn.bind(console),
      error: clientInitConfig.logger?.error ?? console.error.bind(console),
    };

    for (const queueConfig of clientInitConfig.queues ?? []) {
      const runtime = this.runtime(queueConfig.name);
      for (const messageType of queueConfig.handleMessageTypes ?? []) {
        if (typeof messageType !== 'string') {
          const config = messageType as unknown as RmqHandleMessageTypeConfig<string, unknown, QueueName, ExchangeName, RoutingKey>;
          runtime.callbacks.set(config.messageName, config.callbackHandler as (event: AnyEvent<QueueName, ExchangeName, RoutingKey>) => unknown);
        }
      }
    }

    if (!clientInitConfig.stopAutoInit) {
      this.init().catch((error: unknown) => {
        if (error instanceof ClientClosedError) {
          return; // closed during startup
        }
        this.log('error', 'RabbitMQ client initialization failed', error);
        this.emitError({ type: 'init-failed', error });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  private log(level: keyof RabbitMqLogger, ...args: unknown[]) {
    const handler = this.logger[level] || (() => undefined);
    handler(...args);
  }

  private emitError(event: RmqClientErrorEvent) {
    this.errorsSubject.next(event);
  }

  private setState(next: ClientState) {
    if (this.stateSubject.value === next) {
      return;
    }
    this.log('debug', `RabbitMQ client state: ${this.stateSubject.value} -> ${next}`);
    this.stateSubject.next(next);
  }

  /** Current lifecycle state (cheap; suitable for readiness probes). */
  get state(): ClientState {
    return this.stateSubject.value;
  }

  /** Lifecycle state changes. Emits the current state on subscribe. */
  get state$(): Observable<ClientState> {
    return this.stateSubject.asObservable();
  }

  /** Connection, channel, consumer, handler and hook failures. */
  get errors$(): Observable<RmqClientErrorEvent> {
    return this.errorsSubject.asObservable();
  }

  /** `true` when connected and every queue with subscribers is being consumed. */
  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** Emits once, the first time (or next time) the client becomes ready. */
  get onReady(): Observable<boolean> {
    return this.stateSubject.pipe(
      filter((state) => state === 'ready'),
      take(1),
      map(() => true),
    );
  }

  get onConnectionError(): Observable<Error> {
    return this.connectionErrorStream.asObservable();
  }

  get onConnectionClose(): Observable<Error | undefined> {
    return this.connectionCloseStream.asObservable();
  }

  get onMessage(): Observable<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>> {
    return this.messagesStream.asObservable();
  }

  getMetrics(): RabbitMqMetrics {
    return { ...this.metrics };
  }

  getConnection(): ChannelModel | null {
    return this.connection;
  }

  /** The channel used for consuming, acking and topology. */
  getChannel(): Channel | null {
    return this.consumeChannel;
  }

  /** The channel used for publishing (a `ConfirmChannel` when `confirm` is enabled). */
  getPublishChannel(): Channel | ConfirmChannel | null {
    return this.publishChannel;
  }

  // ---------------------------------------------------------------------------
  // Serializers
  // ---------------------------------------------------------------------------

  static registerSerializer(contentType: string, serializer: RabbitMqSerializer) {
    return registerSerializer(contentType, serializer);
  }

  registerSerializer(contentType: string, serializer: RabbitMqSerializer) {
    this.serializers[contentType] = serializer;
    return serializer;
  }

  private getSerializer(contentType?: string): RabbitMqSerializer | null {
    const resolvedContentType = contentType
      || this.clientInitConfig.defaultContentType;

    if (!resolvedContentType) {
      return null;
    }

    return this.serializers[resolvedContentType]
      || getSerializer(resolvedContentType)
      || SERIALIZERS[resolvedContentType]
      || null;
  }

  private serialize(data: unknown, contentType: string | undefined): Buffer {
    const useContentType = contentType || this.clientInitConfig.defaultContentType || ContentTypes.TEXT;
    const serializer = this.getSerializer(useContentType);
    return serializer
      ? serializer.serialize(data)
      : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  }

  private deserialize(message: Message): unknown {
    const contentType: unknown = message.properties.contentType;
    const serializer = this.getSerializer(typeof contentType === 'string' ? contentType : undefined);
    return serializer ? serializer.deserialize(message.content) : message.content;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  private isShuttingDown() {
    return this.state === 'closing' || this.state === 'closed';
  }

  /** Sleep, but wake up early (without a lingering timer) once the client starts closing. */
  private delay(ms: number): Promise<void> {
    if (ms <= 0 || this.isShuttingDown()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const subscription = this.stateSubject
        .pipe(filter((state) => state === 'closing' || state === 'closed'), take(1))
        .subscribe(() => done());
      const timer = setTimeout(() => done(), ms);
      function done() {
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve();
      }
    });
  }

  /** Wait for `promise` (never rejects) but at most until `deadline`, clearing the timer either way. */
  private async untilDeadline(promise: Promise<unknown>, deadline: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    });
    try {
      await Promise.race([promise.then(noop, noop), timeoutPromise]);
    }
    finally {
      clearTimeout(timer);
    }
  }

  private backoff(attempt: number) {
    const base = this.clientInitConfig.retryDelay ?? 1000;
    const max = this.clientInitConfig.maxRetryDelay ?? 30000;
    const exponential = Math.min(max, base * 2 ** attempt);
    return Math.round(Math.min(max, exponential * (1 + Math.random() * 0.2)));
  }

  /**
    Connect, create channels, apply topology and start consumers. Idempotent and safe to re-run:
    resources that are still healthy are kept.
  */
  init(): Promise<void> {
    if (this.isShuttingDown()) {
      return Promise.reject(new ClientClosedError());
    }
    if (!this.initPromise) {
      this.initPromise = this.runInit().catch((error: unknown) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  private assertNotShuttingDown() {
    if (this.isShuttingDown()) {
      throw new ClientClosedError();
    }
  }

  private async runInit(): Promise<void> {
    const { delayStart, pre_init_promises, post_init_promises } = this.clientInitConfig;
    this.setState('connecting');

    await this.delay(delayStart || 0);
    this.assertNotShuttingDown();

    this.log('info', 'Running pre init promises...');
    await Promise.all((pre_init_promises ?? []).map((p) => typeof p === 'function' ? p() : p));
    this.log('info', 'Done running pre init promises.');

    let retriesLeft = this.clientInitConfig.retryAttempts ?? 0;
    let attempt = 0;
    for (;;) {
      this.assertNotShuttingDown();
      try {
        await this.runEstablish();
        if (!this.isHealthy()) {
          throw new RabbitMQClientError('Connection or channel was lost during initialization');
        }
        break;
      }
      catch (error: unknown) {
        if (this.isShuttingDown()) {
          throw new ClientClosedError();
        }
        if (error instanceof TopologyVerificationError || retriesLeft <= 0) {
          this.log('error', 'RabbitMQ initialization failed; giving up', error);
          await this.teardown();
          this.setState('idle');
          throw error;
        }
        retriesLeft -= 1;
        const delay = this.backoff(attempt);
        attempt += 1;
        this.log('warn', `RabbitMQ connection attempt failed; retrying in ${delay}ms (${retriesLeft} retries left)`, error);
        await this.delay(delay);
      }
    }

    // close() may have been called while the last step was finishing
    this.assertNotShuttingDown();
    this.everReady = true;
    this.recoveryAttempt = 0;
    this.setState('ready');
    this.log('info', 'Client initialization complete; waiting for messages/events...');

    this.log('info', 'Running post init promises...');
    await Promise.all((post_init_promises ?? []).map((p) => typeof p === 'function' ? p() : p));
    this.log('info', 'Done running post init promises.');
  }

  private runEstablish(): Promise<void> {
    const promise = this.establish();
    this.establishPromise = promise;
    return promise.finally(() => {
      if (this.establishPromise === promise) {
        this.establishPromise = undefined;
      }
    });
  }

  private async establish(): Promise<void> {
    let connection = this.connection;
    if (!connection) {
      this.log('info', 'Attempting connection to RabbitMQ...');
      connection = await this.connectFn(this.clientInitConfig.connection_url, this.clientInitConfig.socketOptions);
      if (this.isShuttingDown()) {
        await connection.close().catch(noop);
        throw new ClientClosedError();
      }
      this.attachConnectionHandlers(connection);
      this.connection = connection;
      this.log('info', 'Connected to message server');
    }

    if (!this.consumeChannel) {
      const channel = await connection.createChannel();
      this.attachChannelHandlers(channel, 'consume');
      this.consumeChannel = channel;
      if (this.everReady && this.metricsEnabled) {
        this.metrics.channelRecreated += 1;
      }
      if (this.clientInitConfig.prefetch) {
        await channel.prefetch(this.clientInitConfig.prefetch);
      }
      await this.applyTopology(channel);
      this.log('info', 'Consume channel ready');
    }

    if (!this.publishChannel) {
      const channel = this.confirmMode
        ? await connection.createConfirmChannel(this.clientInitConfig.publishChannelOptions)
        : await connection.createChannel(this.clientInitConfig.publishChannelOptions);
      this.attachChannelHandlers(channel, 'publish');
      this.publishChannel = channel;
      if (this.everReady && this.metricsEnabled) {
        this.metrics.channelRecreated += 1;
      }
      this.log('info', `Publish channel ready (confirm: ${this.confirmMode})`);
    }

    const consumeChannel = this.consumeChannel;
    if (!consumeChannel) {
      throw new RabbitMQClientError('Consume channel closed during setup');
    }

    // Subscriptions can be added while we await consume-ok, so loop until none are missing.
    for (let round = 0; round < 10; round++) {
      if (this.consumeChannel !== consumeChannel) {
        throw new RabbitMQClientError('Consume channel closed during setup');
      }
      const starting: Promise<void>[] = [];
      for (const runtime of this.queueRuntimes.values()) {
        if (this.wantsConsumer(runtime) && !runtime.consumerTag) {
          starting.push(runtime.starting ?? this.startConsumer(runtime, consumeChannel));
        }
      }
      if (starting.length === 0) {
        return;
      }
      await Promise.all(starting);
    }
  }

  private async applyTopology(channel: Channel) {
    const { queues = [], exchanges = [], bindings = [] } = this.clientInitConfig;

    if (this.topologyMode === 'none') {
      return;
    }

    if (this.topologyMode === 'verify') {
      for (const queue of queues) {
        try {
          await channel.checkQueue(queue.name);
        }
        catch (error: unknown) {
          throw new TopologyVerificationError('queue', queue.name, error);
        }
      }
      for (const exchange of exchanges) {
        try {
          await channel.checkExchange(exchange.name);
        }
        catch (error: unknown) {
          throw new TopologyVerificationError('exchange', exchange.name, error);
        }
      }
      this.log('info', 'Topology verified');
      return;
    }

    await Promise.all(queues.map((config) => channel.assertQueue(config.name, config.options)));
    this.log('info', 'queues created on channel');
    await Promise.all(exchanges.map((config) => channel.assertExchange(config.name, config.type, config.options)));
    this.log('info', 'exchanges created on channel');
    await Promise.all(bindings.map((config) => channel.bindQueue(config.queue, config.exchange, config.routingKey)));
    this.log('info', 'bindings created on channel');
  }

  private attachConnectionHandlers(connection: ChannelModel) {
    connection.on('error', (error: Error) => {
      this.connectionErrorStream.next(error);
      if (!this.isShuttingDown()) {
        this.log('error', 'RabbitMQ connection error', error);
        this.emitError({ type: 'connection-error', error });
      }
    });
    connection.on('close', (error?: Error) => {
      if (this.connection !== connection) {
        return;
      }
      this.connection = null;
      for (const [channel, role] of [[this.consumeChannel, 'consume'], [this.publishChannel, 'publish']] as const) {
        if (channel) {
          this.handleChannelClosed(channel, role);
        }
      }
      this.connectionCloseStream.next(error);
      if (!this.isShuttingDown()) {
        this.log('warn', 'RabbitMQ connection closed', error);
        this.emitError({ type: 'connection-closed', error });
      }
      this.onFailure();
    });
    connection.on('blocked', (reason: string) => {
      this.log('warn', `RabbitMQ connection blocked by broker: ${reason}`);
    });
    connection.on('unblocked', () => {
      this.log('info', 'RabbitMQ connection unblocked');
    });
  }

  private attachChannelHandlers(channel: Channel, role: RmqChannelRole) {
    channel.on('error', (error: Error) => {
      this.channelErrors.set(channel, error);
      if (!this.isShuttingDown()) {
        this.log('error', `RabbitMQ ${role} channel error`, error);
        this.emitError({ type: 'channel-error', channel: role, error });
      }
    });

    channel.on('close', () => this.handleChannelClosed(channel, role));

    if (role === 'publish') {
      channel.on('return', (message: Message) => this.handleReturn(message));
    }
  }

  private handleChannelClosed(channel: Channel, role: RmqChannelRole) {
    this.deadChannels.add(channel);
    if (role === 'consume') {
      if (this.consumeChannel !== channel) {
        return;
      }
      this.consumeChannel = null;
      for (const record of this.inFlight) {
        if (record.channel === channel) {
          // the broker requeues unacked deliveries of a closed channel
          record.settled = true;
          this.inFlight.delete(record);
        }
      }
      for (const runtime of this.queueRuntimes.values()) {
        if (runtime.consumerChannel === channel) {
          runtime.consumerTag = undefined;
          runtime.consumerChannel = undefined;
        }
      }
    }
    else {
      if (this.publishChannel !== channel) {
        return;
      }
      this.publishChannel = null;
    }

    if (!this.isShuttingDown()) {
      const error = this.channelErrors.get(channel);
      this.log('warn', `RabbitMQ ${role} channel closed`, error);
      this.emitError({ type: 'channel-closed', channel: role, error });
    }
    this.onFailure();
  }

  /** Something broke: leave `ready` and schedule recovery (unless init/close owns the lifecycle). */
  private onFailure() {
    const state = this.state;
    if (state !== 'ready' && state !== 'reconnecting') {
      return;
    }
    this.setState('reconnecting');
    this.scheduleRecovery();
  }

  private scheduleRecovery() {
    if (this.recoveryTimer || this.establishPromise || this.state !== 'reconnecting') {
      return;
    }

    const maxAttempts = this.clientInitConfig.retryAttempts ?? 0;
    if (maxAttempts > 0 && this.recoveryAttempt >= maxAttempts) {
      this.log('error', `RabbitMQ recovery attempts exhausted after ${maxAttempts} tries; closing client.`);
      this.emitError({ type: 'recovery-exhausted', attempts: this.recoveryAttempt });
      void this.close({ drainTimeoutMs: 0 });
      return;
    }

    const delay = this.backoff(this.recoveryAttempt);
    this.recoveryAttempt += 1;
    this.metrics.reconnects += 1;
    this.log('warn', `RabbitMQ recovering in ${delay}ms (attempt ${this.recoveryAttempt}/${maxAttempts || '∞'})`);

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.runRecovery();
    }, delay);
  }

  private async runRecovery() {
    if (this.state !== 'reconnecting') {
      return;
    }
    try {
      await this.runEstablish();
    }
    catch (error: unknown) {
      if (this.state !== 'reconnecting') {
        return;
      }
      this.log('warn', 'RabbitMQ recovery attempt failed', error);
      this.emitError({ type: 'recovery-failed', attempt: this.recoveryAttempt, error });
      this.scheduleRecovery();
      return;
    }

    if (this.state !== 'reconnecting') {
      return;
    }
    if (this.isHealthy()) {
      this.recoveryAttempt = 0;
      this.setState('ready');
      this.log('info', 'RabbitMQ client recovered');
    }
    else {
      this.scheduleRecovery();
    }
  }

  private isHealthy(): boolean {
    if (!this.connection || !this.consumeChannel || !this.publishChannel) {
      return false;
    }
    for (const runtime of this.queueRuntimes.values()) {
      if (this.wantsConsumer(runtime) && !runtime.consumerTag) {
        return false;
      }
    }
    return true;
  }

  /** Close channels and connection without triggering recovery (state must be connecting/closing). */
  private async teardown() {
    const channels = [this.consumeChannel, this.publishChannel];
    for (const channel of channels) {
      if (channel && !this.deadChannels.has(channel)) {
        await channel.close().catch(noop);
      }
    }
    const connection = this.connection;
    if (connection) {
      await connection.close().catch(noop);
    }
    this.consumeChannel = null;
    this.publishChannel = null;
    this.connection = null;
  }

  private async waitFor(predicate: () => boolean, deadline: number): Promise<boolean> {
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await wait(Math.min(25, remaining));
    }
    return true;
  }

  /**
    Graceful shutdown: cancel all consumers, wait (up to `drainTimeoutMs`) for in-flight deliveries to be
    settled, handler promises to settle and publisher confirms to arrive, then close the channels and the
    connection. No reconnect is ever scheduled once `close()` was called.
  */
  close(options: RmqCloseOptions = {}): Promise<void> {
    if (this.state === 'closed') {
      return Promise.resolve();
    }
    if (!this.closePromise) {
      const drainTimeoutMs = options.drainTimeoutMs ?? this.clientInitConfig.drainTimeoutMs ?? 10000;
      this.closePromise = this.runClose(drainTimeoutMs);
    }
    return this.closePromise;
  }

  private async runClose(drainTimeoutMs: number) {
    const deadline = Date.now() + drainTimeoutMs;
    this.setState('closing');
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }

    // 1. stop deliveries
    await this.untilDeadline(
      Promise.all([...this.queueRuntimes.values()].map((runtime) => this.stopQueueConsumer(runtime))),
      deadline,
    );

    // 2. let in-flight work finish
    const drained = await this.waitFor(() => this.inFlight.size === 0 && this.handlerPromises.size === 0, deadline);
    if (!drained) {
      this.log('warn', `RabbitMQ close: drain timeout after ${drainTimeoutMs}ms; ${this.inFlight.size} unsettled deliveries will be redelivered by the broker, ${this.handlerPromises.size} handlers still running.`);
    }

    // 3. wait for outstanding publisher confirms
    const confirmed = await this.waitFor(() => this.pendingPublishes.size === 0, deadline);
    if (!confirmed) {
      this.log('warn', `RabbitMQ close: ${this.pendingPublishes.size} publishes still unconfirmed at drain timeout.`);
    }

    // 4. let an in-flight connect attempt notice the shutdown
    if (this.establishPromise) {
      await this.untilDeadline(this.establishPromise, deadline);
    }

    await this.teardown();
    this.inFlight.clear();
    this.setState('closed');

    this.messagesStream.complete();
    for (const runtime of this.queueRuntimes.values()) {
      runtime.all.complete();
      runtime.fallback.complete();
      for (const subject of runtime.byType.values()) {
        subject.complete();
      }
    }
    this.log('info', 'RabbitMQ client closed.');
  }

  // ---------------------------------------------------------------------------
  // Consumers
  // ---------------------------------------------------------------------------

  private runtime(queue: string): QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>> {
    let runtime = this.queueRuntimes.get(queue);
    if (!runtime) {
      runtime = {
        name: queue,
        consumeOptions: undefined,
        all: new Subject(),
        byType: new Map(),
        fallback: new Subject(),
        callbacks: new Map(),
        listeners: 0,
        paused: false,
        consumerTag: undefined,
        consumerChannel: undefined,
        starting: undefined,
        stopping: undefined,
      };
      this.queueRuntimes.set(queue, runtime);
    }
    return runtime;
  }

  private typeSubject(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>, messageType: string) {
    let subject = runtime.byType.get(messageType);
    if (!subject) {
      subject = new Subject();
      runtime.byType.set(messageType, subject);
    }
    return subject;
  }

  private wantsConsumer(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>): boolean {
    return !runtime.paused
      && (runtime.listeners > 0 || runtime.callbacks.size > 0)
      && !this.isShuttingDown();
  }

  /** Start or cancel the queue's consumer so it matches whether anyone listens. */
  private syncConsumer(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>) {
    if (runtime.starting || runtime.stopping) {
      return; // re-synced when they finish
    }
    const wants = this.wantsConsumer(runtime);
    if (wants && !runtime.consumerTag) {
      const channel = this.consumeChannel;
      if (!channel || this.establishPromise) {
        return; // (re)connect will start it
      }
      void this.startConsumer(runtime, channel);
    }
    else if (!wants && runtime.consumerTag) {
      void this.cancelConsumer(runtime);
    }
  }

  private startConsumer(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>, channel: Channel): Promise<void> {
    const noAck = runtime.consumeOptions?.noAck === true;
    const ref: { tag: string | undefined } = { tag: undefined };
    const started = channel.consume(
      runtime.name,
      (message) => this.handleDelivery(runtime, channel, ref.tag, noAck, message),
      { ...(runtime.consumeOptions ?? {}) },
    ).then((reply) => {
      ref.tag = reply.consumerTag;
      if (channel !== this.consumeChannel || this.deadChannels.has(channel)) {
        return;
      }
      runtime.consumerTag = reply.consumerTag;
      runtime.consumerChannel = channel;
      this.log('info', `Registered: Now listening to messages/events on queue ${runtime.name}...`, { consumerTag: reply.consumerTag });
    });

    const tracked = started.finally(() => {
      runtime.starting = undefined;
      this.syncConsumer(runtime);
    });
    runtime.starting = tracked.catch(noop);
    tracked.catch((error: unknown) => {
      this.log('warn', `Failed to consume queue ${runtime.name}`, error);
    });
    return tracked;
  }

  private cancelConsumer(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>): Promise<void> {
    const tag = runtime.consumerTag;
    const channel = runtime.consumerChannel;
    runtime.consumerTag = undefined;
    runtime.consumerChannel = undefined;
    if (!tag || !channel || this.deadChannels.has(channel)) {
      return Promise.resolve();
    }
    const stopping = channel.cancel(tag)
      .then(() => {
        this.log('info', `Stopped consuming queue ${runtime.name}`, { consumerTag: tag });
      })
      .catch((error: unknown) => {
        this.log('warn', `Failed to cancel consumer for queue ${runtime.name}`, error);
      })
      .finally(() => {
        runtime.stopping = undefined;
        this.syncConsumer(runtime);
      });
    runtime.stopping = stopping;
    return stopping;
  }

  private async stopQueueConsumer(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>) {
    if (runtime.starting) {
      await runtime.starting;
    }
    if (runtime.stopping) {
      await runtime.stopping;
    }
    await this.cancelConsumer(runtime);
  }

  /**
    Cancel the consumer of one queue (or of all queues) and resolve when the broker confirmed the cancel.
    Stays in effect across reconnects until `startConsuming()`.
  */
  async stopConsuming(queue?: QueueName): Promise<void> {
    const targets = queue !== undefined ? [this.runtime(queue)] : [...this.queueRuntimes.values()];
    for (const runtime of targets) {
      runtime.paused = true;
    }
    await Promise.all(targets.map((runtime) => this.stopQueueConsumer(runtime)));
  }

  /** Undo `stopConsuming()`; consumers restart for queues that have subscribers. */
  async startConsuming(queue?: QueueName): Promise<void> {
    const targets = queue !== undefined ? [this.runtime(queue)] : [...this.queueRuntimes.values()];
    for (const runtime of targets) {
      runtime.paused = false;
      this.syncConsumer(runtime);
    }
    await Promise.all(targets.map((runtime) => runtime.starting ?? Promise.resolve()));
  }

  private onServerCancel(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>, channel: Channel, tag: string | undefined) {
    if (runtime.consumerChannel !== channel || runtime.consumerTag !== tag) {
      return;
    }
    runtime.consumerTag = undefined;
    runtime.consumerChannel = undefined;
    this.log('warn', `Consumer for queue ${runtime.name} was cancelled by the broker`, { consumerTag: tag });
    this.emitError({ type: 'consumer-cancelled', queue: runtime.name, consumerTag: tag ?? '' });
    this.onFailure();
  }

  private handleDelivery(
    runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>,
    channel: Channel,
    tag: string | undefined,
    noAck: boolean,
    message: ConsumeMessage | null,
  ) {
    if (!message) {
      this.onServerCancel(runtime, channel, tag);
      return;
    }

    if (this.metricsEnabled) {
      this.metrics.messagesReceived += 1;
    }

    const record: DeliveryRecord = {
      message,
      channel,
      queue: runtime.name,
      noAck,
      settled: noAck,
      settling: false,
    };
    this.deliveries.set(message, record);
    if (!noAck) {
      this.inFlight.add(record);
    }

    const messageType = typeof message.properties.type === 'string' ? message.properties.type as string : undefined;

    let data: unknown;
    try {
      data = this.deserialize(message);
    }
    catch (error: unknown) {
      this.log('error', `Failed to deserialize message on queue ${runtime.name}; rejecting it (requeue = false)`, error);
      this.emitError({ type: 'handler-error', queue: runtime.name, messageType, error });
      this.settle(record, 'reject');
      return;
    }

    const event = this.createEvent(record, data);

    const onDeliver = this.clientInitConfig.hooks?.onDeliver;
    if (onDeliver) {
      try {
        onDeliver(event);
      }
      catch (error: unknown) {
        this.emitError({ type: 'hook-error', hook: 'onDeliver', error });
      }
    }

    this.messagesStream.next(event);
    this.dispatch(runtime, event, messageType);
  }

  private dispatch(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>, event: AnyEvent<QueueName, ExchangeName, RoutingKey>, messageType: string | undefined) {
    let handled = false;

    if (runtime.all.observed) {
      runtime.all.next(event);
      handled = true;
    }

    if (messageType) {
      const typed = runtime.byType.get(messageType);
      if (typed?.observed) {
        this.log('debug', `message type handler found; pushing to ${messageType} handler on queue ${runtime.name}`);
        typed.next(event);
        handled = true;
      }
      else {
        const callback = runtime.callbacks.get(messageType);
        if (callback) {
          this.log('debug', `message type callback found; pushing to ${messageType} callback on queue ${runtime.name}`);
          this.runHandler(runtime, event, callback);
          handled = true;
        }
      }
    }
    else if (runtime.fallback.observed) {
      this.log('debug', `No message type found; pushing to default handler on queue ${runtime.name}`);
      runtime.fallback.next(event);
      handled = true;
    }

    if (!handled) {
      this.handleUnhandled(runtime, event, messageType);
    }
  }

  private handleUnhandled(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>, event: AnyEvent<QueueName, ExchangeName, RoutingKey>, messageType: string | undefined) {
    const description = `No handler for message type ${messageType ?? '(none)'} on queue ${runtime.name}`;
    switch (this.unhandledPolicy) {
      case 'ack':
        this.log('debug', `${description}; auto acknowledging.`);
        event.ack();
        return;
      case 'nack':
        this.log('warn', `${description}; rejecting (requeue = false).`);
        event.nack(false);
        return;
      case 'default':
        if (runtime.fallback.observed) {
          this.log('debug', `${description}; pushing to default handler.`);
          runtime.fallback.next(event);
          return;
        }
        break;
      case 'nack-requeue':
        break;
    }
    this.log('warn', `${description}; requeueing.`);
    event.nack(true);
  }

  /** Run a callback handler, tracking a returned promise so `close()` can wait for it. */
  private runHandler(
    runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>,
    event: AnyEvent<QueueName, ExchangeName, RoutingKey>,
    handler: (event: AnyEvent<QueueName, ExchangeName, RoutingKey>) => unknown,
  ) {
    let result: unknown;
    try {
      result = handler(event);
    }
    catch (error: unknown) {
      this.onHandlerError(runtime, event, error);
      return;
    }
    if (isPromiseLike(result)) {
      const tracked: Promise<void> = Promise.resolve(result).then(
        () => undefined,
        (error: unknown) => this.onHandlerError(runtime, event, error),
      );
      this.handlerPromises.add(tracked);
      void tracked.finally(() => this.handlerPromises.delete(tracked));
    }
  }

  private onHandlerError(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>, event: AnyEvent<QueueName, ExchangeName, RoutingKey>, error: unknown) {
    const messageType = typeof event.message.properties.type === 'string' ? event.message.properties.type as string : undefined;
    this.log('error', `Handler failed on queue ${runtime.name}`, { messageType, error });
    this.emitError({ type: 'handler-error', queue: runtime.name, messageType, error });
    if (!event.settled) {
      event.nack(true);
    }
  }

  private createEvent(record: DeliveryRecord, data: unknown): AnyEvent<QueueName, ExchangeName, RoutingKey> {
    return {
      data,
      message: record.message,
      queue: record.queue as QueueName,
      consumerTag: record.message.fields.consumerTag,
      get settled() {
        return record.settled;
      },
      ack: () => {
        this.settle(record, 'ack');
      },
      nack: (requeue = true) => {
        this.settle(record, requeue ? 'requeue' : 'reject');
      },
      republish: (options) => this.republishDelivery(record, options),
      retry: (options) => this.retryMessage(record.message, options),
      handlerError: (error, options) => this.handleMessageError(record.message, error, options),
      publishEvent: <P>(options: RmqPublishEventParams<P, ExchangeName, RoutingKey>) => this.publishEvent<P>(options),
      sendMessage: <U>(options: RmqSendMessageParams<U, QueueName>) => this.sendMessage<U>(options),
      sendRequest: <U>(options: RmqSendRequestParams<unknown, QueueName>) => this.sendRequest<U>(options),
    };
  }

  /**
    Ack/nack a tracked delivery exactly once. Stale deliveries (whose channel closed) are ignored, since
    the broker already requeued them and acking on another channel would close it with 406.
  */
  private settle(record: DeliveryRecord, action: SettleAction, internal = false): boolean {
    if (record.noAck) {
      return false;
    }
    if (record.settled || (record.settling && !internal)) {
      this.log('warn', `Ignoring ${action}: delivery on queue ${record.queue} was already settled`, { deliveryTag: record.message.fields.deliveryTag });
      return false;
    }
    record.settled = true;
    record.settling = false;
    this.inFlight.delete(record);

    if (this.deadChannels.has(record.channel)) {
      this.log('warn', `Cannot ${action} delivery on queue ${record.queue}: its channel closed; the broker will redeliver it.`);
      return false;
    }

    try {
      if (action === 'ack') {
        record.channel.ack(record.message);
        if (this.metricsEnabled) {
          this.metrics.messagesAcked += 1;
        }
        this.log('debug', 'Acknowledged rmq message.');
      }
      else {
        record.channel.nack(record.message, false, action === 'requeue');
        if (this.metricsEnabled) {
          this.metrics.messagesNacked += 1;
        }
        this.log('debug', `Nacknowledged rmq message with requeue=${action === 'requeue'}.`);
      }
    }
    catch (error: unknown) {
      this.log('warn', `Failed to ${action} delivery on queue ${record.queue}`, error);
      return false;
    }
    return true;
  }

  /** Ack a delivery. Deliveries consumed through this client are acked at most once. */
  ack(message: Message) {
    const record = this.deliveries.get(message);
    if (record) {
      this.settle(record, 'ack');
      return;
    }
    if (!this.consumeChannel) {
      return;
    }
    this.consumeChannel.ack(message);
    if (this.metricsEnabled) {
      this.metrics.messagesAcked += 1;
    }
  }

  nack(message: Message, requeue: boolean = true) {
    const record = this.deliveries.get(message);
    if (record) {
      this.settle(record, requeue ? 'requeue' : 'reject');
      return;
    }
    if (!this.consumeChannel) {
      return;
    }
    this.consumeChannel.nack(message, false, requeue);
    if (this.metricsEnabled) {
      this.metrics.messagesNacked += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  /** Wrap a long-lived subject so subscriptions are counted (lazy consume / cancel on last unsubscribe). */
  private observe(runtime: QueueRuntime<AnyEvent<QueueName, ExchangeName, RoutingKey>>, subject: Subject<AnyEvent<QueueName, ExchangeName, RoutingKey>>): Observable<AnyEvent<QueueName, ExchangeName, RoutingKey>> {
    return new Observable<AnyEvent<QueueName, ExchangeName, RoutingKey>>((subscriber) => {
      const inner = subject.subscribe(subscriber);
      runtime.listeners += 1;
      this.syncConsumer(runtime);
      return () => {
        inner.unsubscribe();
        runtime.listeners -= 1;
        this.syncConsumer(runtime);
      };
    });
  }

  /**
    Subscribe to a queue. The queue is consumed while at least one returned stream/handler is subscribed,
    independent of whether it is listed in `queues`. Streams survive reconnects.
  */
  onQueue(queue: QueueName, options?: Options.Consume) {
    const runtime = this.runtime(queue);
    if (options) {
      runtime.consumeOptions = options;
    }

    const handle = <TMessageName extends MessageName>(messageType: TMessageName) => {
      return this.observe(runtime, this.typeSubject(runtime, messageType)) as Observable<RmqEventMessage<TPayloadMap[TMessageName], QueueName, ExchangeName, RoutingKey>>;
    };

    const handleDefault = () => {
      return this.observe(runtime, runtime.fallback);
    };

    const onEvent = <TMessageName extends MessageName>(messageType: TMessageName, handler: RmqEventHandler<TPayloadMap[TMessageName], QueueName, ExchangeName, RoutingKey>): Subscription => {
      return this.observe(runtime, this.typeSubject(runtime, messageType)).subscribe({
        next: (event) => this.runHandler(runtime, event, handler as (event: AnyEvent<QueueName, ExchangeName, RoutingKey>) => unknown),
      });
    };

    const handleAll = (handler: RmqEventHandler<TPayloadMap[keyof TPayloadMap], QueueName, ExchangeName, RoutingKey>): Subscription => {
      return this.observe(runtime, runtime.all).subscribe({
        next: (event) => this.runHandler(runtime, event, handler as (event: AnyEvent<QueueName, ExchangeName, RoutingKey>) => unknown),
      });
    };

    return {
      handle,
      handleAll,
      handleDefault,
      onEvent,
    };
  }

  /** Every delivery on the queue (consumed while subscribed). */
  forQueue(queue: QueueName, options?: Options.Consume): Observable<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>> {
    const runtime = this.runtime(queue);
    if (options) {
      runtime.consumeOptions = options;
    }
    return this.observe(runtime, runtime.all);
  }

  // ---------------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------------

  private async acquirePublishChannel(): Promise<Channel | ConfirmChannel> {
    const readyTimeoutMs = this.clientInitConfig.readyTimeoutMs ?? 10000;
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (this.state === 'closed') {
        throw new ClientClosedError();
      }
      const channel = this.publishChannel;
      if (channel && !this.deadChannels.has(channel)) {
        if (this.drainPromise) {
          this.log('debug', 'Publish waiting for channel drain (backpressure)');
          await this.drainPromise;
          continue;
        }
        return channel;
      }
      if (this.state === 'closing') {
        throw new ClientClosedError('RabbitMQ client is closing');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ClientNotReadyError(this.state, `RabbitMQ client not ready for publishing after ${readyTimeoutMs}ms (state: ${this.state})`);
      }
      try {
        const state = await firstValueFrom(this.stateSubject.pipe(
          filter((value) => value === 'ready' || value === 'closed' || value === 'closing'),
          timeout({ first: remaining }),
        ));
        const current = this.publishChannel;
        if (state === 'ready' && (!current || this.deadChannels.has(current))) {
          throw new ClientNotReadyError(this.state, 'RabbitMQ publish channel is not available');
        }
      }
      catch (error: unknown) {
        if (error instanceof TimeoutError) {
          throw new ClientNotReadyError(this.state, `RabbitMQ client not ready for publishing after ${readyTimeoutMs}ms (state: ${this.state})`);
        }
        throw error;
      }
    }
  }

  private markBackpressure(channel: Channel) {
    if (this.drainPromise) {
      return;
    }
    this.log('debug', 'Publish channel buffer full; waiting for drain');
    const promise = new Promise<void>((resolve) => {
      const done = () => {
        channel.removeListener('drain', done);
        channel.removeListener('close', done);
        if (this.drainPromise === promise) {
          this.drainPromise = undefined;
        }
        resolve();
      };
      channel.on('drain', done);
      channel.on('close', done);
    });
    this.drainPromise = promise;
  }

  private preparePublishProperties(options: Options.Publish, exchange: string, routingKey: string): RmqPublishProperties {
    const headers: Record<string, unknown> = { ...((options.headers as Record<string, unknown> | undefined) ?? {}) };
    const properties: RmqPublishProperties = { ...options, headers };
    const onPublish = this.clientInitConfig.hooks?.onPublish;
    if (onPublish) {
      try {
        onPublish(properties, { exchange, routingKey });
      }
      catch (error: unknown) {
        this.emitError({ type: 'hook-error', hook: 'onPublish', error });
      }
    }
    return properties;
  }

  private trackPending(pending: PendingPublish, mandatory: boolean) {
    this.pendingPublishes.add(pending);
    if (mandatory && pending.messageId !== undefined) {
      const list = this.pendingByMessageId.get(pending.messageId);
      if (list) {
        list.push(pending);
      }
      else {
        this.pendingByMessageId.set(pending.messageId, [pending]);
      }
    }
  }

  private untrackPending(pending: PendingPublish) {
    this.pendingPublishes.delete(pending);
    if (pending.messageId === undefined) {
      return;
    }
    const list = this.pendingByMessageId.get(pending.messageId);
    if (!list) {
      return;
    }
    const index = list.indexOf(pending);
    if (index >= 0) {
      list.splice(index, 1);
    }
    if (list.length === 0) {
      this.pendingByMessageId.delete(pending.messageId);
    }
  }

  private handleReturn(message: Message) {
    const fields = message.fields as unknown as { exchange: string, routingKey: string, replyCode: number, replyText: string };
    const messageId = typeof message.properties.messageId === 'string' ? message.properties.messageId as string : undefined;
    const pending = messageId !== undefined
      ? this.pendingByMessageId.get(messageId)?.find((entry) => !entry.returned)
      : undefined;
    if (pending) {
      pending.returned = { replyCode: fields.replyCode, replyText: fields.replyText };
      return;
    }
    if (this.metricsEnabled) {
      this.metrics.publishReturned += 1;
    }
    this.log('warn', `Message returned by broker: ${fields.replyCode} ${fields.replyText}`, { exchange: fields.exchange, routingKey: fields.routingKey, messageId });
    this.emitError({
      type: 'message-returned',
      exchange: fields.exchange,
      routingKey: fields.routingKey,
      replyCode: fields.replyCode,
      replyText: fields.replyText,
      messageId,
    });
  }

  /**
    Publish raw content. With `confirm` (default) resolves on broker ack, rejects with
    `PublishNackedError`, `PublishReturnedError` (mandatory + unroutable) or `PublishChannelClosedError`.
    Waits for `drain` under backpressure and for readiness up to `readyTimeoutMs`.
  */
  private async publishRaw(exchange: string, routingKey: string, content: Buffer, options: Options.Publish): Promise<void> {
    const channel = await this.acquirePublishChannel();
    const properties = this.preparePublishProperties(options, exchange, routingKey);
    if (this.metricsEnabled) {
      this.metrics.messagesPublished += 1;
    }

    if (!this.confirmMode) {
      const ok = channel.publish(exchange, routingKey, content, properties);
      if (!ok) {
        this.markBackpressure(channel);
        await this.drainPromise;
      }
      return;
    }

    if (properties.mandatory && properties.messageId === undefined) {
      properties.messageId = randomUUID();
    }
    const confirmChannel = channel as ConfirmChannel;

    await new Promise<void>((resolve, reject) => {
      const pending: PendingPublish = { exchange, routingKey, messageId: properties.messageId, returned: undefined };
      this.trackPending(pending, properties.mandatory === true);
      let ok: boolean;
      try {
        ok = confirmChannel.publish(exchange, routingKey, content, properties, (error: unknown) => {
          this.untrackPending(pending);
          if (error) {
            const channelError = this.channelErrors.get(confirmChannel);
            const closed = channelError !== undefined
              || this.deadChannels.has(confirmChannel)
              || (error instanceof Error && /closed/i.test(error.message));
            if (closed) {
              reject(new PublishChannelClosedError(pending, channelError ?? error));
            }
            else {
              if (this.metricsEnabled) {
                this.metrics.publishNacked += 1;
              }
              reject(new PublishNackedError(pending));
            }
            return;
          }
          if (pending.returned) {
            if (this.metricsEnabled) {
              this.metrics.publishReturned += 1;
            }
            reject(new PublishReturnedError(pending, pending.returned));
            return;
          }
          if (this.metricsEnabled) {
            this.metrics.publishConfirmed += 1;
          }
          resolve();
        });
      }
      catch (error: unknown) {
        this.untrackPending(pending);
        reject(new PublishChannelClosedError(pending, error));
        return;
      }
      if (!ok) {
        this.markBackpressure(confirmChannel);
      }
    });
  }

  /** Publish to a queue through the default exchange. */
  async sendMessage<T = unknown>(options: RmqSendMessageParams<T, QueueName>): Promise<void> {
    const { data, publishOptions, queue } = options;
    const content = this.serialize(data, publishOptions.contentType);
    await this.publishRaw('', queue, content, publishOptions);
  }

  /** Publish to an exchange. */
  async publishEvent<T = unknown>(options: RmqPublishEventParams<T, ExchangeName, RoutingKey>): Promise<void> {
    const { data, routingKey, publishOptions, exchange } = options;
    const content = this.serialize(data, publishOptions.contentType);
    await this.publishRaw(exchange, routingKey || '', content, publishOptions);
  }

  /**
    Confirm-publish a copy of the delivery, then settle the original: ack on success,
    nack(requeue = true) and rethrow on failure. The original is never settled before the copy exists.
  */
  private async copyThenAck(message: Message, exchange: string, routingKey: string, properties: Options.Publish): Promise<void> {
    const record = this.deliveries.get(message);
    if (record) {
      if (record.noAck) {
        await this.publishRaw(exchange, routingKey, message.content, properties);
        return;
      }
      if (record.settled || record.settling) {
        throw new MessageAlreadySettledError();
      }
      record.settling = true;
      try {
        await this.publishRaw(exchange, routingKey, message.content, properties);
      }
      catch (error: unknown) {
        this.settle(record, 'requeue', true);
        throw error;
      }
      this.settle(record, 'ack', true);
      return;
    }

    try {
      await this.publishRaw(exchange, routingKey, message.content, properties);
    }
    catch (error: unknown) {
      this.nack(message, true);
      throw error;
    }
    this.ack(message);
  }

  private republishDelivery(record: DeliveryRecord, options: RmqRepublishOptions<ExchangeName, RoutingKey>): Promise<void> {
    const properties = copyMessageProperties(record.message, options.properties, options.headers);
    if (properties.mandatory === undefined) {
      properties.mandatory = true;
    }
    return this.copyThenAck(record.message, options.exchange, options.routingKey, properties);
  }

  /**
    Confirm-publish a copy of a delivery (same body; properties and headers merged), THEN ack the original.
    On publish failure the original is nacked with `requeue = true` and the promise rejects.
    `mandatory` defaults to `true`.
  */
  republish(message: Message, options: RmqRepublishOptions<ExchangeName, RoutingKey>): Promise<void> {
    const properties = copyMessageProperties(message, options.properties, options.headers);
    if (properties.mandatory === undefined) {
      properties.mandatory = true;
    }
    return this.copyThenAck(message, options.exchange, options.routingKey, properties);
  }

  /**
    @deprecated Use `event.republish()` to a retry exchange backed by broker TTL queues.

    Copies the message to `options.queue` (default: the queue it was consumed from) and acks the original
    only after the copy is confirmed. A `delayMs` is waited in-process while the original stays unacked.
  */
  async retryMessage(message: Message, options: RmqRetryMessageOptions<QueueName> = {}): Promise<void> {
    const { delayMs = 0, requeue = true, queue } = options;
    const targetQueue = queue || this.deliveries.get(message)?.queue || message.fields.routingKey || '';
    if (!targetQueue) {
      this.nack(message, requeue);
      return;
    }
    if (delayMs > 0) {
      await wait(delayMs);
    }
    await this.copyThenAck(message, '', targetQueue, copyMessageProperties(message, { persistent: true }));
    if (this.metricsEnabled) {
      this.metrics.messagesRetried += 1;
    }
  }

  /**
    @deprecated Use `event.republish()` to a dead-letter exchange.

    Copies the message to `queue` (default: `{consumed queue}.dlq`) with an `x-death-reason` header and
    acks the original only after the copy is confirmed.
  */
  async deadLetter(message: Message, reason: string, queue?: string): Promise<void> {
    const sourceQueue = this.deliveries.get(message)?.queue || message.fields.routingKey || 'dead-letter';
    const targetQueue = queue || `${sourceQueue}.dlq`;
    await this.copyThenAck(message, '', targetQueue, copyMessageProperties(message, { persistent: true }, { 'x-death-reason': reason }));
  }

  /**
    Declares a DLX, a DLQ and the source queue's dead-letter arguments. Requires `configure` permission.
  */
  async setupDeadLetterQueue(config: DeadLetterQueueConfig) {
    const channel = this.consumeChannel;
    if (!channel) {
      throw new ClientNotReadyError(this.state);
    }

    const {
      sourceQueue,
      deadLetterQueue = `${sourceQueue}.dlq`,
      deadLetterExchange = `${sourceQueue}.dlx`,
      deadLetterRoutingKey = deadLetterQueue,
      queueOptions = {},
      deadLetterQueueOptions = { durable: true },
      maxLength,
      messageTtlMs,
    } = config;

    const dlxArguments: Record<string, unknown> = {
      ...(maxLength ? { 'x-max-length': maxLength } : {}),
      ...(messageTtlMs ? { 'x-message-ttl': messageTtlMs } : {}),
    };

    await channel.assertExchange(deadLetterExchange, 'direct', { durable: true });
    await channel.assertQueue(deadLetterQueue, {
      durable: true,
      ...deadLetterQueueOptions,
      arguments: {
        ...(deadLetterQueueOptions.arguments || {}),
        ...dlxArguments,
      },
    });
    await channel.bindQueue(deadLetterQueue, deadLetterExchange, deadLetterRoutingKey);

    const sourceQueueArguments = {
      ...(queueOptions.arguments || {}),
      'x-dead-letter-exchange': deadLetterExchange,
      'x-dead-letter-routing-key': deadLetterRoutingKey,
    };

    await channel.assertQueue(sourceQueue, {
      ...queueOptions,
      arguments: sourceQueueArguments,
    });

    return {
      sourceQueue,
      deadLetterQueue,
      deadLetterExchange,
      deadLetterRoutingKey,
    };
  }

  /**
    Centralized failure handling for a delivery. Copies go out (confirmed) before the original is acked.

    - `retryQueue`: copy to the retry queue, then ack
    - `deadLetterExchange`: publish to the DLX (routing key `deadLetterRoutingKey` or the source queue), then ack
    - `deadLetterQueue` / `deadLetterRoutingKey`: copy to the DLQ, then ack
    - otherwise: `nack(requeue)`
  */
  async handleMessageError(message: Message, error: unknown, options: HandleMessageErrorOptions = {}): Promise<RmqMessageErrorOutcome> {
    const record = this.deliveries.get(message);
    const sourceQueue = record?.queue;
    const {
      reason = error instanceof Error ? error.message : 'unknown_error',
      requeue = false,
      deadLetterQueue,
      deadLetterExchange,
      deadLetterRoutingKey,
      retryQueue,
      retryDelayMs = 0,
      loggerMessage = 'RabbitMQ message processing failed',
    } = options;

    this.log('error', loggerMessage, {
      reason,
      error,
      queue: sourceQueue,
      routingKey: message.fields.routingKey,
      messageType: message.properties.type as unknown,
      deliveryTag: message.fields.deliveryTag,
    });

    if (retryQueue) {
      if (retryDelayMs > 0) {
        await wait(retryDelayMs);
      }
      await this.copyThenAck(message, '', retryQueue, copyMessageProperties(message, { persistent: true }));
      if (this.metricsEnabled) {
        this.metrics.messagesRetried += 1;
      }
      return { action: 'retry', targetQueue: retryQueue, retryDelayMs };
    }

    if (deadLetterExchange) {
      const routingKey = deadLetterRoutingKey ?? sourceQueue ?? message.fields.routingKey;
      await this.copyThenAck(message, deadLetterExchange, routingKey, copyMessageProperties(message, { persistent: true }, { 'x-death-reason': reason }));
      return { action: 'dead-letter', targetExchange: deadLetterExchange, routingKey };
    }

    if (deadLetterQueue || deadLetterRoutingKey) {
      const targetQueue = deadLetterQueue || `${sourceQueue || message.fields.routingKey || 'dead-letter'}.dlq`;
      await this.copyThenAck(message, '', targetQueue, copyMessageProperties(message, { persistent: true }, { 'x-death-reason': reason }));
      return { action: 'dead-letter', targetQueue };
    }

    this.nack(message, requeue);
    return { action: 'nack', requeue };
  }

  // ---------------------------------------------------------------------------
  // Request / reply
  // ---------------------------------------------------------------------------

  /**
    Send a request and await the reply on a temporary exclusive queue.
    Note: declaring the reply queue requires `configure` permission on it.
  */
  async sendRequest<T = unknown>(
    options: RmqSendRequestParams<unknown, QueueName>,
    autoAckOnReceiveReply: boolean = true,
    timeoutMs?: number
  ): Promise<RmqEventMessage<T, QueueName, ExchangeName, RoutingKey>> {
    this.log('debug', 'sendRequest:', options);
    await this.acquirePublishChannel();
    const channel = this.consumeChannel;
    if (!channel) {
      throw new ClientNotReadyError(this.state);
    }

    const startedAt = Date.now();
    const replyQueue = randomUUID();
    const correlationId = options.publishOptions.correlationId || randomUUID();
    const waitMs = timeoutMs ?? this.clientInitConfig.rpcRequestTimeoutMs ?? 30000;

    await channel.assertQueue(replyQueue, { exclusive: true, durable: false, autoDelete: true });
    this.log('debug', `Created temp queue ${replyQueue} for client.`);

    let consumerTag: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<ConsumeMessage>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RabbitMQClientError(`RabbitMQ request timed out after ${waitMs}ms for correlationId ${correlationId}`));
      }, waitMs);
      channel.consume(replyQueue, (message) => {
        if (!message) {
          reject(new RabbitMQClientError('RPC reply consumer was cancelled by the broker'));
          return;
        }
        if (message.properties.correlationId === correlationId) {
          resolve(message);
        }
        else {
          this.log('debug', 'Discarding reply with unexpected correlationId', { expected: correlationId, received: message.properties.correlationId as unknown });
          channel.ack(message);
        }
      }).then((ok) => {
        consumerTag = ok.consumerTag;
      }, reject);
    });
    reply.catch(noop);

    try {
      const { data, publishOptions, queue } = options;
      const content = this.serialize(data, publishOptions.contentType);
      if (this.metricsEnabled) {
        this.metrics.rpcRequests += 1;
      }
      await this.publishRaw('', queue, content, { ...publishOptions, correlationId, replyTo: replyQueue });
      this.log('debug', 'request/rpc sent; awaiting response...', { correlationId, replyQueue });

      const message = await reply;
      if (this.metricsEnabled) {
        this.metrics.rpcResponses += 1;
      }
      const record: DeliveryRecord = { message, channel, queue: replyQueue, noAck: false, settled: false, settling: false };
      this.deliveries.set(message, record);
      this.inFlight.add(record);
      const event = this.createEvent(record, this.deserialize(message)) as RmqEventMessage<T, QueueName, ExchangeName, RoutingKey>;
      this.log('debug', 'received response from request/rpc:', { correlationId, total_time: (Date.now() - startedAt) / 1000 });
      if (autoAckOnReceiveReply) {
        event.ack();
      }
      return event;
    }
    finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (consumerTag && !this.deadChannels.has(channel)) {
        await channel.cancel(consumerTag).catch((error: unknown) => {
          this.log('debug', 'Ignoring cancel failure for RPC consumer', { consumerTag, error });
        });
      }
    }
  }
}

