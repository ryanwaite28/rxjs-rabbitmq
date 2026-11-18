import {
  v1 as uuidv1,
  v4 as uuidv4,
} from 'uuid';



import {
  Connection,
  Channel,
  Replies,
  connect,
  Options,
  ConsumeMessage
} from "amqplib";

import {
  BehaviorSubject,
  filter,
  firstValueFrom,
  map,
  mergeMap,
  Observable,
  ReplaySubject,
  Subject,
  Subscription,
  take,
  tap,
} from "rxjs";

import {
  getSerializer,
  mapify,
  registerSerializer,
  SERIALIZERS,
  uniqueValue,
  wait
} from "./utils";

import {
  DeadLetterQueueConfig,
  HandleMessageErrorOptions,
  MapType,
  QueueExchangeBindingConfig,
  RabbitMqInitConfig,
  RabbitMqLogger,
  RmqEventHandler,
  RmqEventMessage,
  RmqHandleMessageTypeConfig,
  RmqHandleMessageTypeConfigs,
  RmqMessageTypeHandler,
  RmqPublishEventParams,
  RmqSendMessageParams,
  RmqSendRequestParams,
  RmqPayloadMap,
  RmqRetryMessageOptions,
  RabbitMqSerializer,
  RabbitMqSerializerMap
} from "./types";

import { ContentTypes } from "./enums";




export type RmgOnEventHandler = (event: RmqEventMessage, rmqClient?: RabbitMQClient) => void;

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
  private clientInitConfig: RabbitMqInitConfig<QueueName, ExchangeName, RoutingKey, MessageName, TPayloadMap>;
  private logger: RabbitMqLogger;

  private connection: Connection;
  private channel: Channel;
  private isReady: boolean = false;
  private isReadyStream: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(this.isReady);
  private connectionErrorStream: Subject<any> = new Subject<any>();
  private connectionCloseStream: Subject<any> = new Subject<any>();
  private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
  private serializers: RabbitMqSerializerMap = {};
  private reconnectAttempts: number = 0;
  
  /*
    Handle all messages from all queues on this client
  */
  private messagesStream: Subject<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>> = new Subject<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>();
  private messagesStreamsByQueue: MapType<Subject<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>> = {};

  private queues: MapType<Replies.AssertQueue> = {};
  private exchanges:MapType<Replies.AssertExchange> = {};
  private bindings: QueueExchangeBindingConfig<QueueName, ExchangeName, RoutingKey>[] = [];

  private DEFAULT_LISTENER_TYPE: string = '__default';
  private queueListeners: MapType<Subscription> = {};
  private registeredQueueConsumers: Array<{ queue: string, options?: Options.Consume }> = [];
  private metricsEnabled: boolean;
  private metrics: {
    messagesReceived: number;
    messagesPublished: number;
    messagesAcked: number;
    messagesNacked: number;
    messagesRetried: number;
    rpcRequests: number;
    rpcResponses: number;
    reconnects: number;
  } = {
    messagesReceived: 0,
    messagesPublished: 0,
    messagesAcked: 0,
    messagesNacked: 0,
    messagesRetried: 0,
    rpcRequests: 0,
    rpcResponses: 0,
    reconnects: 0,
  };
  
  private queueToEventHandleMapping: Map<string, Map<string, ReplaySubject<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>>> = new Map();
  private queueToEventCallbackMapping: Map<string, Map<string, RmqMessageTypeHandler<unknown>>> = new Map();

  private log(level: keyof RabbitMqLogger, ...args: unknown[]) {
    const handler = this.logger[level] || (() => undefined);
    handler(...args);
  }

  get onReady(): Observable<boolean> {
    return this.isReadyStream.asObservable().pipe(
      filter((state) => !!state),
      take(1)
    );
  }
  
  get onConnectionError(): Observable<any> {
    return this.connectionErrorStream.asObservable();
  }

  get onConnectionClose(): Observable<any> {
    return this.connectionCloseStream.asObservable();
  }

  get onMessage(): Observable<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>> {
    return this.messagesStream.asObservable();
  }

  constructor(clientInitConfig: RabbitMqInitConfig<QueueName, ExchangeName, RoutingKey, MessageName, TPayloadMap>) {
    this.clientInitConfig = clientInitConfig;
    this.serializers = { ...(clientInitConfig.serializers || {}) };
    this.metricsEnabled = !!clientInitConfig.metrics;
    this.logger = {
      debug: clientInitConfig.logger?.debug ?? (() => undefined),
      info: clientInitConfig.logger?.info ?? console.info.bind(console),
      warn: clientInitConfig.logger?.warn ?? console.warn.bind(console),
      error: clientInitConfig.logger?.error ?? console.error.bind(console),
    };
    !clientInitConfig.stopAutoInit && this.init();
  }

  static registerSerializer(contentType: string, serializer: RabbitMqSerializer) {
    return registerSerializer(contentType, serializer);
  }

  registerSerializer(contentType: string, serializer: RabbitMqSerializer) {
    this.serializers[contentType] = serializer;
    return serializer;
  }

  private getSerializer(contentType?: string) {
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

  getMetrics() {
    return { ...this.metrics };
  }

  private resubscribeToRegisteredQueues() {
    for (const { queue, options } of this.registeredQueueConsumers) {
      if (this.queueListeners[queue]) {
        this.queueListeners[queue].unsubscribe();
        delete this.queueListeners[queue];
      }
      this.listenToQueue(queue, options);
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.reconnectTimeout) {
      return;
    }

    const retryAttempts = this.clientInitConfig.retryAttempts || 0;
    if (retryAttempts > 0 && this.reconnectAttempts >= retryAttempts) {
      this.log('error', `RabbitMQ reconnect attempts exhausted after ${retryAttempts} tries.`);
      return;
    }

    this.isReady = false;
    this.isReadyStream.next(false);
    this.reconnectAttempts += 1;
    this.metrics.reconnects += 1;
    const retryDelay = this.clientInitConfig.retryDelay || 1000;

    this.log('warn', `${reason}; reconnecting in ${retryDelay}ms (attempt ${this.reconnectAttempts}/${retryAttempts || '∞'})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      this.init().catch((error) => {
        this.log('error', 'Reconnect failed', error);
      });
    }, retryDelay);
  }

  init() {
    if (this.isReady) {
      this.log('info', 'Already initialized');
      return Promise.resolve();
    }
    const {
      delayStart,
      connection_url,
      prefetch,
      queues,
      exchanges,
      bindings,
      pre_init_promises,
      post_init_promises
    } = this.clientInitConfig;

    let retryAttempts: number = this.clientInitConfig.retryAttempts || 0;
    const retryDelay: number = this.clientInitConfig.retryDelay || 0;
    
    const init: () => Promise<any> = () => {
      // creating connection
      this.log('info', 'Attempting connection to Rabbit MQ...');
      return connect(connection_url)
        .then((connection) => {
          this.connection = connection;
          this.log('info', 'Connected to message server');
          return this.connection.createChannel();
        })
        // creating channel
        .then((channel) => {
          this.channel = channel;
          if (prefetch) {
            this.channel.prefetch(prefetch || 1);
          }
          this.log('info', 'Channel created on message server');
        })
        // assert to queues
        .then(() => {
          const promises: Promise<Replies.AssertQueue>[] = [];

          for (const queueConfig of queues) {
            const queueListenersMap = new Map<string, ReplaySubject<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>>();
            const queueCallbacksMap = new Map<string, RmqMessageTypeHandler<unknown>>();
            this.queueToEventHandleMapping.set(queueConfig.name, queueListenersMap);
            this.queueToEventCallbackMapping.set(queueConfig.name, queueCallbacksMap);
            
            // by default, create an observable stream on the queue for unidentified/null routing keys
            queueListenersMap.set(this.DEFAULT_LISTENER_TYPE, new ReplaySubject());

            const useHandleMessageTypes: RmqHandleMessageTypeConfigs<MessageName, TPayloadMap> = queueConfig.handleMessageTypes || [];
            for (const messageType of useHandleMessageTypes) {
              if (typeof messageType === 'string') {
                queueListenersMap.set(messageType as string, new ReplaySubject());
              }
              else {
                const config: RmqHandleMessageTypeConfig<MessageName, TPayloadMap[MessageName]> = messageType;
                queueCallbacksMap.set(config.messageName, config.callbackHandler as RmqMessageTypeHandler<unknown>);
              }
            }

            promises.push(this.channel.assertQueue(queueConfig.name, queueConfig.options));
          }

          return Promise.all(promises).then((values) => {
            this.queues = mapify(values, 'queue');
            this.log('info', 'queues created on channel');
          });
        })
        // assert exchanges
        .then(() => {
          const promises: Promise<Replies.AssertExchange>[] = exchanges.map((config) => this.channel.assertExchange(config.name, config.type, config.options));
          return Promise.all(promises).then(values => {
            this.exchanges = mapify(values, 'exchange');
            this.log('info', 'exchanges created on channel');
          });
        })
        // apply bindings
        .then(() => {
          const promises: Promise<Replies.Empty>[] = bindings.map((config) => this.channel.bindQueue(config.queue, config.exchange, config.routingKey));
          // bind the exclusive queue to all the exchanges
          // const exclusiveBindings = bindings.map((config) => this.channel.bindQueue(this.EXCLUSIVE_QUEUE, config.exchange, config.routingKey));
          return Promise.all(promises).then(values => {
            this.log('info', 'bindings created on channel');
          });
        })
        .then(() => {
          this.log('info', 'Client initialization complete; waiting for messages/events...');

          // initialization complete; listen for connection issues to retry again
          retryAttempts = this.clientInitConfig.retryAttempts;
          
          this.connection.on("error", (err) => {
            this.connectionErrorStream.next(err);
            this.log('error', 'RabbitMQ connection error', err);
            this.scheduleReconnect('RabbitMQ connection error');
          });
          this.connection.on("close", (err) => {
            this.connectionCloseStream.next(err);
            this.log('warn', 'RabbitMQ connection closed', err);
            this.scheduleReconnect('RabbitMQ connection closed');
          });

          this.reconnectAttempts = 0;
          this.isReady = true;
          this.isReadyStream.next(true);
          this.resubscribeToRegisteredQueues();
        })

        .catch((error) => {
          this.log('error', 'connection error, retryAttempts:', retryAttempts, error);
          if (retryAttempts === 0) {
            this.log('error', 'all retry attemptys exhaused; exiting...');
            throw error;
          }
          retryAttempts = retryAttempts - 1;
          return wait(retryDelay).then(init);
        });
    };

    return wait(delayStart || 0)
    .then(() => {
      this.log('info', 'Running pre init promises...');
      return Promise.all(pre_init_promises?.map(p => p instanceof Promise ? p : p()) || []).then(() => {
        this.log('info', 'Done running pre init promises.');
      });
    })
    .then(init)
    .then(() => {
      this.log('info', 'Running post init promises...');
      return Promise.all(post_init_promises?.map(p => p instanceof Promise ? p : p()) || []).then(() => {
        this.log('info', 'Done running post init promises.');
      });
    });
  }

  getConnection() {
    return this.connection;
  }

  getChannel() {
    return this.channel;
  }

  private getQueueListener(queue: string, options?: Options.Consume) {
    return () => {
      // callback
      const handleCallback = (message: ConsumeMessage | null) => {
        if (!message) {
          // console.log('Consumer cancelled by server');
          // throw new Error('Consumer cancelled by server');
          return;
        }

        // console.log(`Received queue message.`, message);
        
        // see if a listener was created for the routing key
        const messageType = message.properties.type;
        const useContentType = message.properties.contentType;
        const serializer = this.getSerializer(useContentType);
        const useData = serializer ? serializer.deserialize(message.content) : message.content;
        if (this.metricsEnabled) {
          this.metrics.messagesReceived += 1;
        }
        const messageObj: RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey> = {
          data: useData,
          message,
          ack: () => {
            this.ack(message);
          },
          nack: (requeue = true) => {
            this.nack(message, requeue);
          },
          retry: (options = {}) => {
            this.retryMessage(message, options);
          },
          handlerError: (error, options = {}) => {
            return this.handleMessageError(message, error, options);
          },
          sendMessage: this.sendMessage.bind(this),
          sendRequest: this.sendRequest.bind(this),
          publishEvent: this.publishEvent.bind(this),
        };

        // send message to general stream
        this.messagesStream.next(messageObj);
        // send message to queue stream
        !!this.messagesStreamsByQueue[queue] && this.messagesStreamsByQueue[queue].next(messageObj);
        
        // console.log(`Message on queue ${queue}:`, messageObj);

        const queueListeners = this.queueToEventHandleMapping.get(queue) ?? new Map();
        const queueCallbacks = this.queueToEventCallbackMapping.get(queue) ?? new Map();

        if (!messageType) {
          // no type key found, push to default stream
          this.log('debug', `No message type found; pushing to default handler on queue ${queue}`);
          const defaultListener = queueListeners.get(this.DEFAULT_LISTENER_TYPE);
          defaultListener?.next(messageObj);
          return;
        }

        const typeListener = queueListeners.get(messageType);
        if (typeListener) {
          // there is a registered listener for the type, push to that stream
          this.log('debug', `message type handler found; pushing to ${messageType} handler on queue ${queue}`);
          typeListener.next(messageObj);
        }
        else if (queueCallbacks.has(messageType)) {
          // there is a registered listener for the type, push to that stream
          this.log('debug', `message type callback found; pushing to ${messageType} callback on queue ${queue}`);
          const callbackHandler = queueCallbacks.get(messageType)!;
          callbackHandler(messageObj);
        }
        else {
          // no registered listener
          if (this.clientInitConfig.autoAckUnhandledMessageTypes) {
            this.log('debug', `No handler found for message type ${messageType} on queue ${queue}; auto acknowledging.`);
            this.ack(message);
            return;
          }
          else if (this.clientInitConfig.pushUnhandledMessageTypesToDefaultHandler) {
            this.log('debug', `No handler found for message type ${messageType} on queue ${queue}; pushing to ${this.DEFAULT_LISTENER_TYPE} handler.`);
            const defaultListener = queueListeners.get(this.DEFAULT_LISTENER_TYPE);
            defaultListener?.next(messageObj);
            return;
          }
          else {
            // console.error(`Message received with unregistered message type handler/callback. Please add message type "${messageType}" in the list of message types for the queue config in the constructor.`);
          }
        }
      };
      // END callback

      this.channel.consume(queue, handleCallback, { ...(options || {}) });
    }
  }

  private listenToQueue(queue: string, options?: Options.Consume) {
    if (this.queueListeners[queue]) {
      this.log('debug', `Already Registered messages/events listener for queue: ${queue}`);
      return;
    }

    this.registeredQueueConsumers = this.registeredQueueConsumers.filter((entry) => entry.queue !== queue);
    this.registeredQueueConsumers.push({ queue, options });

    this.log('info', `Registering messages/events listener for queue: ${queue}`);
    const startQueueListener = this.getQueueListener(queue, options);

    this.messagesStreamsByQueue[queue] = new Subject<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>();
    this.queueListeners[queue] = this.onReady.pipe(
      tap((readyState) => {
        startQueueListener()
      })
    )
    .subscribe({
      next: (readyState) => {
        this.log('info', `Registered: Now listening to messages/events on queue ${queue}...`);
      }
    });
  }

  onQueue(queue: QueueName, options?: Options.Consume) {
    // listen for messages on the queue
    this.listenToQueue(queue, options);

    const handle = <TMessageName extends MessageName>(messageType: TMessageName) => {
      return this.onReady.pipe(
        mergeMap((ready: boolean, index: number) => {
          const queueListeners = this.queueToEventHandleMapping.get(queue);
          if (!queueListeners?.has(messageType)) {
            throw new Error(`The provided routing key was not provided during initialization. Please add routing key "${messageType}" in the list of routing keys for the queue config in the constructor.`);
          }
          return queueListeners.get(messageType)!.asObservable() as Observable<RmqEventMessage<TPayloadMap[TMessageName]>>;
        })
      );
    };

    const handleDefault = () => {
      return this.onReady.pipe(
        mergeMap((ready: boolean, index: number) => {
          const queueListeners = this.queueToEventHandleMapping.get(queue);
          return (queueListeners?.get(this.DEFAULT_LISTENER_TYPE) ?? new ReplaySubject<RmqEventMessage>()).asObservable();
        })
      );
    };

    const onEvent = <TMessageName extends MessageName>(messageType: TMessageName, handler: RmqEventHandler<TPayloadMap[TMessageName], QueueName, ExchangeName, RoutingKey>) => {
      return this.onReady
        .pipe(mergeMap(() => this.messagesStreamsByQueue[queue]))
        .pipe(filter((event: RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>) => event.message.properties.type === messageType))
        .subscribe({ next: (event) => handler(event as RmqEventMessage<TPayloadMap[TMessageName], QueueName, ExchangeName, RoutingKey>) });
    };

    const handleAll = (handler: RmqEventHandler<TPayloadMap[keyof TPayloadMap], QueueName, ExchangeName, RoutingKey>) => {
      return this.onReady
        .pipe(mergeMap(() => this.messagesStreamsByQueue[queue]))
        .subscribe({ next: (event) => handler(event as RmqEventMessage<TPayloadMap[keyof TPayloadMap], QueueName, ExchangeName, RoutingKey>) });
    };

    return {
      handle,
      handleAll,
      handleDefault,
      onEvent,
    };
  }

  forQueue(queue: QueueName, options?: Options.Consume) {
    this.listenToQueue(queue, options);
    return this.messagesStreamsByQueue[queue].asObservable();
  }

  ack(message: ConsumeMessage) {
    this.channel.ack(message);
    if (this.metricsEnabled) {
      this.metrics.messagesAcked += 1;
    }
    this.log('debug', 'Acknoledged rmq message.');
  }

  nack(message: ConsumeMessage, requeue: boolean = true) {
    if (!this.channel) {
      return;
    }
    this.channel.nack(message, false, requeue);
    if (this.metricsEnabled) {
      this.metrics.messagesNacked += 1;
    }
    this.log('debug', `Nacknowledged rmq message with requeue=${requeue}.`);
  }

  retryMessage(message: ConsumeMessage, options: RmqRetryMessageOptions<QueueName> = {}) {
    const { delayMs = 0, requeue = true, queue = '' } = options;
    const targetQueue = queue || message.fields.routingKey || '';
    if (delayMs > 0) {
      setTimeout(() => {
        if (targetQueue) {
          this.channel.sendToQueue(targetQueue, message.content, { persistent: true, ...message.properties });
        }
      }, delayMs);
    }
    else if (targetQueue) {
      this.channel.sendToQueue(targetQueue, message.content, { persistent: true, ...message.properties });
    }
    this.nack(message, requeue);
    if (this.metricsEnabled) {
      this.metrics.messagesRetried += 1;
    }
  }

  deadLetter(message: ConsumeMessage, reason: string, queue?: string) {
    const targetQueue = queue || `${message.fields.routingKey || 'dead-letter'}.dlq`;
    const headers = { ...(message.properties.headers || {}), 'x-death-reason': reason };
    this.channel.sendToQueue(targetQueue, message.content, {
      ...message.properties,
      headers,
      persistent: true,
    });
    this.nack(message, false);
  }

  async setupDeadLetterQueue(config: DeadLetterQueueConfig) {
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

    await this.channel.assertExchange(deadLetterExchange, 'direct', { durable: true });
    await this.channel.assertQueue(deadLetterQueue, {
      durable: true,
      ...deadLetterQueueOptions,
      arguments: {
        ...(deadLetterQueueOptions.arguments || {}),
        ...dlxArguments,
      },
    });
    await this.channel.bindQueue(deadLetterQueue, deadLetterExchange, deadLetterRoutingKey);

    const sourceQueueArguments = {
      ...(queueOptions.arguments || {}),
      'x-dead-letter-exchange': deadLetterExchange,
      'x-dead-letter-routing-key': deadLetterRoutingKey,
    };

    await this.channel.assertQueue(sourceQueue, {
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

  handleMessageError(message: ConsumeMessage, error: unknown, options: HandleMessageErrorOptions = {}) {
    const {
      reason = error instanceof Error ? error.message : 'unknown_error',
      requeue = false,
      deadLetterQueue,
      deadLetterExchange,
      deadLetterRoutingKey,
      retryQueue,
      retryDelayMs,
      loggerMessage = 'RabbitMQ message processing failed',
    } = options;

    this.log('error', loggerMessage, {
      reason,
      error,
      routingKey: message?.fields?.routingKey,
      queue: message?.fields?.routingKey,
    });

    if (retryQueue && retryDelayMs && retryDelayMs > 0) {
      const targetQueue = retryQueue;
      setTimeout(() => {
        if (this.channel) {
          this.channel.sendToQueue(targetQueue, message.content, {
            ...message.properties,
            persistent: true,
          });
        }
      }, retryDelayMs);
      this.nack(message, false);
      return { action: 'retry' as const, targetQueue, retryDelayMs };
    }

    if (deadLetterQueue || deadLetterExchange || deadLetterRoutingKey) {
      const targetQueue = deadLetterQueue || `${message.fields.routingKey || 'dead-letter'}.dlq`;
      this.deadLetter(message, reason, targetQueue);
      return { action: 'dead-letter' as const, targetQueue };
    }

    this.nack(message, requeue);
    return { action: 'nack' as const, requeue };
  }

  async close() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    if (this.channel) {
      await this.channel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }

    this.isReady = false;
    this.isReadyStream.next(false);
    this.log('info', 'RabbitMQ client closed.');
  }

  sendMessage<T = unknown>(options: RmqSendMessageParams<T, QueueName>) {
    const send = () => {
      const { data, publishOptions, queue } = options;
      const useContentType = publishOptions.contentType || this.clientInitConfig.defaultContentType || ContentTypes.TEXT;
      const serializer = this.getSerializer(useContentType);
      const useData: Buffer = serializer
        ? (serializer.serialize(data) as Buffer)
        : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
      if (this.metricsEnabled) {
        this.metrics.messagesPublished += 1;
      }
      this.channel.sendToQueue(queue, useData, { ...publishOptions, appId: publishOptions.appId });
    };

    if (!this.isReady) {
      this.log('debug', 'wait until ready to send message...');
      firstValueFrom(this.onReady).then((readyState) => {
        this.log('debug', 'now ready to send message', { readyState });
        send();
      });
    }
    else {
      this.log('debug', 'is ready to send message');
      send();
    }
  }

  private getRpcMethods(temporaryRpcQueue: string, options: {
    queue: QueueName,
    data: unknown,
    publishOptions: Options.Publish,
  }, autoAckOnReceiveReply: boolean, requestTimeoutMs?: number) {
    const start_time = Date.now();
    const consumerTag = uniqueValue();
    const correlationId = options.publishOptions.correlationId || uuidv4();
    const timeoutMs = requestTimeoutMs ?? this.clientInitConfig.rpcRequestTimeoutMs ?? 30000;

    const send = () => {
      const { data, publishOptions, queue } = options;
      const useContentType = publishOptions.contentType || this.clientInitConfig.defaultContentType || ContentTypes.TEXT;
      const serializer = this.getSerializer(useContentType);
      const useData: Buffer = serializer
        ? (serializer.serialize(data) as Buffer)
        : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
      if (this.metricsEnabled) {
        this.metrics.rpcRequests += 1;
      }
      this.channel.sendToQueue(queue, useData, { ...publishOptions, correlationId, replyTo: temporaryRpcQueue, appId: publishOptions.appId });
    };
  
    const watch = <T> () => {
      return new Promise<RmqEventMessage<T, QueueName, ExchangeName, RoutingKey>>(async (resolve, reject) => {
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const cleanup = async () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          try {
            await this.channel.cancel(consumerTag);
          } catch (error) {
            this.log('debug', 'Ignoring cancel failure for RPC consumer', { consumerTag, error });
          }
        };

        timeoutHandle = setTimeout(async () => {
          if (settled) {
            return;
          }
          settled = true;
          await cleanup();
          reject(new Error(`RabbitMQ request timed out after ${timeoutMs}ms for correlationId ${correlationId}`));
        }, timeoutMs);

        this.log('debug', 'request/rpc sent; awaiting response...', { correlationId, consumerTag, temporaryRpcQueue });
  
        const replyHandler = (message: ConsumeMessage | null) => {
          if (!message || settled) {
            return;
          }

          this.log('debug', 'Received reply.', { message });
          const correlationIdMatch = message.properties.correlationId == correlationId;
          const isReplyToRequest: boolean = !!message && correlationIdMatch;
          this.log('debug', { isReplyToRequest, consumerTag, correlationIdMatch, requestCorrelationId: correlationId, responseCorrelationId: message.properties.correlationId });
          
          if (isReplyToRequest) {
            settled = true;
            void cleanup();
            const useContentType = message.properties.contentType;
            const serializer = this.getSerializer(useContentType);
            const useData = serializer ? serializer.deserialize(message.content) : message.content;
            if (this.metricsEnabled) {
              this.metrics.rpcResponses += 1;
            }
            const messageObj: RmqEventMessage<T, QueueName, ExchangeName, RoutingKey> = {
              data: useData as T,
              message,
              ack: () => {
                this.ack(message);
              },
              nack: (requeue = true) => {
                this.nack(message, requeue);
              },
              retry: (options = {}) => {
                this.retryMessage(message, options);
              },
              handlerError: (error, options = {}) => {
                return this.handleMessageError(message, error, options);
              },
              sendMessage: this.sendMessage.bind(this),
              sendRequest: this.sendRequest.bind(this),
              publishEvent: this.publishEvent.bind(this),
            };
            const end_time = Date.now();
            const total_time = (end_time - start_time) / 1000;
            const time_in_seconds = total_time.toFixed();
            this.log('debug', 'received response from request/rpc:', { start_time, end_time, total_time, time_in_seconds, messageObj, options });
            if (autoAckOnReceiveReply) {
              this.ack(message);
            }
            resolve(messageObj);
          }
        };
    
        this.channel.consume(temporaryRpcQueue, replyHandler, { consumerTag });
      });
    };

    return { watch, send };
  }

  sendRequest<T = unknown>(
    options: RmqSendRequestParams<unknown, QueueName>,
    autoAckOnReceiveReply: boolean = true,
    timeoutMs?: number
  ) {
    this.log('debug', 'sendRequest:', options);

    return new Promise<RmqEventMessage<T, QueueName, ExchangeName, RoutingKey>>(async (resolve, reject) => {
      
      const temporaryRpcQueue = uuidv1();

      const newQueue = await this.channel.assertQueue(temporaryRpcQueue, { exclusive: true, durable: false, autoDelete: true }).then((response) => {
        this.log('debug', `Created temp queue ${temporaryRpcQueue} for client.`);
        return response;
      });

      const rpc = this.getRpcMethods(temporaryRpcQueue, options, autoAckOnReceiveReply, timeoutMs);

      if (!this.isReady) {
        this.log('debug', 'waiting until ready to send request');
        firstValueFrom(this.onReady).then((readyState) => {
          this.log('debug', 'now ready and watching temp queue', { readyState });
          rpc.watch<T>().then((message: RmqEventMessage<T, QueueName, ExchangeName, RoutingKey>) => {
            resolve(message);
          }).catch(reject); // first listen on the reply queue
          this.log('debug', 'sending request');
          rpc.send(); // then send the rpc/rmq message
        }).catch(reject);
      }
      else {
        this.log('debug', 'now ready and watching temp queue');
        rpc.watch<T>().then((message: RmqEventMessage<T, QueueName, ExchangeName, RoutingKey>) => {
          resolve(message);
        }).catch(reject); // first listen on the reply queue
        this.log('debug', 'sending request');
        rpc.send(); // then send the rpc/rmq message
      }
    });
  }

  publishEvent<T = unknown>(options: RmqPublishEventParams<T, ExchangeName, RoutingKey>) {
    const publish = () => {
      const { data, routingKey, publishOptions, exchange } = options;
      const useContentType = publishOptions.contentType || this.clientInitConfig.defaultContentType || ContentTypes.TEXT;
      const serializer = this.getSerializer(useContentType);
      const useData: Buffer = serializer
        ? (serializer.serialize(data) as Buffer)
        : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
      if (this.metricsEnabled) {
        this.metrics.messagesPublished += 1;
      }
      this.channel.publish(exchange, routingKey || '', useData, { ...publishOptions, appId: publishOptions.appId });
    };

    if (!this.isReady) {
      this.log('debug', 'wait until ready to publish event');
      this.onReady.subscribe({
        next: () => {
          this.log('debug', 'now ready to publish event');
          publish();
        }
      });
    }
    else {
      this.log('debug', 'is ready to publish event');
      publish();
    }
  }
}
