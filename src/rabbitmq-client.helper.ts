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
  mapify,
  SERIALIZERS,
  uniqueValue,
  wait
} from "./utils";

import {
  MapType,
  QueueExchangeBindingConfig,
  RabbitMqInitConfig,
  RmqEventHandler,
  RmqEventMessage,
  RmqHandleMessageTypeConfig,
  RmqHandleMessageTypeConfigs,
  RmqMessageTypeHandler,
  RmqPublishEventParams,
  RmqSendMessageParams
} from "./types";

import { ContentTypes } from "./enums";




export type RmgOnEventHandler = (event: RmqEventMessage, rmqClient?: RabbitMQClient) => void;

/**
  Rabbit MQ - RxJS Powered
*/
export class RabbitMQClient {
  private clientInitConfig: RabbitMqInitConfig;

  private connection: Connection;
  private channel: Channel;
  private isReady: boolean = false;
  private isReadyStream: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(this.isReady);
  private connectionErrorStream: Subject<any> = new Subject<any>();
  private connectionCloseStream: Subject<any> = new Subject<any>();
  
  /*
    Handle all messages from all queues on this client
  */
  private messagesStream: Subject<RmqEventMessage> = new Subject<RmqEventMessage>();
  private messagesStreamsByQueue: MapType<Subject<RmqEventMessage>> = {};

  private queues: MapType<Replies.AssertQueue> = {};
  private exchanges:MapType<Replies.AssertExchange> = {};
  private bindings: QueueExchangeBindingConfig[] = [];

  private DEFAULT_LISTENER_TYPE: string = '__default';
  private queueListeners: MapType<Subscription> = {};
  
  private queueToEventHandleMapping: MapType<
    MapType<ReplaySubject<RmqEventMessage>>
  > = {};
  private queueToEventCallbackMapping: MapType<
    MapType<RmqMessageTypeHandler>
  > = {};

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

  get onMessage(): Observable<RmqEventMessage> {
    return this.messagesStream.asObservable();
  }

  constructor(clientInitConfig: RabbitMqInitConfig) {
    this.clientInitConfig = clientInitConfig;
    !clientInitConfig.stopAutoInit && this.init();
  }

  init() {
    if (this.isReady) {
      console.log(`Already initialized`);
      return;
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
      console.log(`Attempting connection to Rabbit MQ...`);
      return connect(connection_url)
        .then((connection) => {
          this.connection = connection;
          console.log(`Connected to message server`);
          return this.connection.createChannel();
        })
        // creating channel
        .then((channel) => {
          this.channel = channel;
          if (prefetch) {
            this.channel.prefetch(prefetch || 1);
          }
          console.log(`Channel created on message server`);
        })
        // assert to queues
        .then(() => {
          const promises: Promise<Replies.AssertQueue>[] = [];

          for (const queueConfig of queues) {
            this.queueToEventHandleMapping[queueConfig.name] = {};
            this.queueToEventCallbackMapping[queueConfig.name] = {};
            
            const queueListenersMap = this.queueToEventHandleMapping[queueConfig.name];
            const queueCallbacksMap = this.queueToEventCallbackMapping[queueConfig.name];
            
            // by default, create an observable stream on the queue for unidentified/null routing keys
            queueListenersMap[this.DEFAULT_LISTENER_TYPE] = new ReplaySubject();

            const useHandleMessageTypes: RmqHandleMessageTypeConfigs = queueConfig.handleMessageTypes || [];
            for (const messageType of useHandleMessageTypes) {
              if (typeof messageType === 'string') {
                queueListenersMap[messageType as string] = new ReplaySubject();
              }
              else {
                const config: RmqHandleMessageTypeConfig = messageType;
                queueCallbacksMap[config.messageName] = config.callbackHandler;
              }
            }

            promises.push(this.channel.assertQueue(queueConfig.name, queueConfig.options));
          }

          return Promise.all(promises).then((values) => {
            this.queues = mapify(values, 'queue');
            console.log(`queues created on channel`);
          });
        })
        // assert exchanges
        .then(() => {
          const promises: Promise<Replies.AssertExchange>[] = exchanges.map((config) => this.channel.assertExchange(config.name, config.type, config.options));
          return Promise.all(promises).then(values => {
            this.exchanges = mapify(values, 'exchange');
            console.log(`exchanges created on channel`);
          });
        })
        // apply bindings
        .then(() => {
          const promises: Promise<Replies.Empty>[] = bindings.map((config) => this.channel.bindQueue(config.queue, config.exchange, config.routingKey));
          // bind the exclusive queue to all the exchanges
          // const exclusiveBindings = bindings.map((config) => this.channel.bindQueue(this.EXCLUSIVE_QUEUE, config.exchange, config.routingKey));
          return Promise.all(promises).then(values => {
            console.log(`bindings created on channel`);
          });
        })
        .then(() => {
          console.log(`Client initialization complete; waiting for messages/events...\n`);

          // initialization complete; listen for connection issues to retry again
          retryAttempts = this.clientInitConfig.retryAttempts;
          
          this.connection.on("error", (err) => {
            this.connectionErrorStream.next(err);
          });
          this.connection.on("close", (err) => {
            this.connectionCloseStream.next(err);
          });

          this.isReady = true;
          this.isReadyStream.next(true);
        })

        .catch((error) => {
          console.log(`connection error, retryAttempts: ${retryAttempts}`, error);
          if (retryAttempts === 0) {
            console.log(`all retry attemptys exhaused; exiting...`);
            throw error;
          }
          retryAttempts = retryAttempts - 1;
          return wait(retryDelay).then(init);
        });
    };

    return wait(delayStart || 0)
    .then(() => {
      console.log(`Running pre init promises...`);
      return Promise.all(pre_init_promises?.map(p => p instanceof Promise ? p : p()) || []).then(() => {
        console.log(`Done running pre init promises.\n`);
      });
    })
    .then(init)
    .then(() => {
      console.log(`Running post init promises...`);
      return Promise.all(post_init_promises?.map(p => p instanceof Promise ? p : p()) || []).then(() => {
        console.log(`Done running post init promises. \n\n-------\n\n`);
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
        const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].deserialize(message.content) : message.content;
        const messageObj: RmqEventMessage = {
          data: useData,
          message,
          ack: () => {
            this.ack(message);
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

        if (!messageType) {
          // no type key found, push to default stream
          console.log(`No message type found; pushing to default handler on queue ${queue}`);
          this.queueToEventHandleMapping[queue][this.DEFAULT_LISTENER_TYPE].next(messageObj);
          return;
        }

        if (this.queueToEventHandleMapping[queue][messageType]) {
          // there is a registered listener for the type, push to that stream
          console.log(`message type handler found; pushing to ${messageType} handler on queue ${queue}`);
          this.queueToEventHandleMapping[queue][messageType].next(messageObj);
        }
        else if (this.queueToEventCallbackMapping[queue][messageType]) {
          // there is a registered listener for the type, push to that stream
          console.log(`message type callback found; pushing to ${messageType} callback on queue ${queue}`);
          const callbackHandler = this.queueToEventCallbackMapping[queue][messageType];
          callbackHandler(messageObj);
        }
        else {
          // no registered listener
          if (this.clientInitConfig.autoAckUnhandledMessageTypes) {
            console.log(`No handler found for message type ${messageType} on queue ${queue}; auto acknowledging.`);
            this.ack(message);
            return;
          }
          else if (this.clientInitConfig.pushUnhandledMessageTypesToDefaultHandler) {
            console.log(`No handler found for message type ${messageType} on queue ${queue}; pushing to ${this.DEFAULT_LISTENER_TYPE} handler.`);
            this.queueToEventHandleMapping[queue][this.DEFAULT_LISTENER_TYPE].next(messageObj);
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
      console.log(`Already Registered messages/events listener for queue: ${queue}`);
      return;
    }

    console.log(`Registering messages/events listener for queue: ${queue}`);
    const startQueueListener = this.getQueueListener(queue, options);

    this.messagesStreamsByQueue[queue] = new Subject<RmqEventMessage>();
    this.queueListeners[queue] = this.onReady.pipe(
      tap((readyState) => {
        startQueueListener()
      })
    )
    .subscribe({
      next: (readyState) => {
        console.log(`Registered: Now listening to messages/events on queue ${queue}...`);
      }
    });
  }

  onQueue(queue: string, options?: Options.Consume) {
    // listen for messages on the queue
    this.listenToQueue(queue, options);
    
    const handle = (messageType: string) => {
      return this.onReady.pipe(
        mergeMap((ready: boolean, index: number) => {
          if (!this.queueToEventHandleMapping[queue][messageType]) {
            throw new Error(`The provided routing key was not provided during initialization. Please add routing key "${messageType}" in the list of routing keys for the queue config in the constructor.`);
          }
          return this.queueToEventHandleMapping[queue][messageType].asObservable();
        })
      );
    };

    const handleDefault = () => {
      return this.onReady.pipe(
        mergeMap((ready: boolean, index: number) => this.queueToEventHandleMapping[queue][this.DEFAULT_LISTENER_TYPE].asObservable())
      );
    };

    /**
      Providing callback function approach
    */
    const onEvent = (messageType: string, handler: RmqEventHandler) => {
      return this.onReady
        .pipe(mergeMap(() => this.messagesStreamsByQueue[queue]))
        .pipe(filter((event: RmqEventMessage) => event.message.properties.type === messageType))
        .subscribe({ next: handler });
    };

    const handleAll = (handler: RmqEventHandler) => {
      return this.onReady
        .pipe(mergeMap(() => this.messagesStreamsByQueue[queue]))
        .subscribe({ next: handler });
    };

    return {
      handle,
      handleAll,
      handleDefault,
      onEvent,
    };
  }

  forQueue(queue: string, options?: Options.Consume) {
    this.listenToQueue(queue, options);
    return this.messagesStreamsByQueue[queue].asObservable();
  }

  ack(message: ConsumeMessage) {
    this.channel.ack(message);
    console.log(`Acknoledged rmq message.`);
  }

  sendMessage(options: RmqSendMessageParams) {
    const send = () => {
      const { data, publishOptions, queue } = options;
      const useContentType = publishOptions.contentType || ContentTypes.TEXT;
      const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].serialize(data) : data;
      this.channel.sendToQueue(queue, useData, { ...publishOptions, appId: publishOptions.appId });
    };

    if (!this.isReady) {
      console.log(`wait until ready to send message...`);
      firstValueFrom(this.onReady).then((readyState) => {
        console.log(`now ready to send message`, { readyState });
        send();
      });
    }
    else {
      console.log(`is ready to send message`);
      send();
    }
  }

  private getRpcMethods(temporaryRpcQueue: string, options: {
    queue: string,
    data: any,
    publishOptions: Options.Publish,
  }) {
    const start_time = Date.now();
    const consumerTag = uniqueValue();
    const correlationId = options.publishOptions.correlationId || uuidv4();

    const send = () => {
      const { data, publishOptions, queue } = options;
      const useContentType = publishOptions.contentType || ContentTypes.TEXT;
      const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].serialize(data) : data;
      this.channel.sendToQueue(queue, useData, { ...publishOptions, correlationId, replyTo: temporaryRpcQueue, appId: publishOptions.appId });
    };
  
    const watch = <T> () => {
      return new Promise<RmqEventMessage<T>>(async (resolve, reject) => {
        console.log(`request/rpc sent; awaiting response...`, { correlationId, consumerTag, temporaryRpcQueue });
  
        const replyHandler = (message: ConsumeMessage | null) => {
          console.log(`\nReceived reply.\n`, { message });
          const correlationIdMatch = message!.properties.correlationId == correlationId;
          const isReplyToRequest: boolean = !!message && correlationIdMatch;
          console.log({ isReplyToRequest, consumerTag, correlationIdMatch, requestCorrelationId: correlationId, responseCorrelationId: message!.properties.correlationId });
          
          if (isReplyToRequest) {
            const useContentType = message!.properties.contentType;
            const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].deserialize(message!.content) : message!.content;
            const messageObj: RmqEventMessage = {
              data: useData,
              message: message!,
              ack: () => {
                this.ack(message!);
              },
              sendMessage: this.sendMessage.bind(this),
              sendRequest: this.sendRequest.bind(this),
              publishEvent: this.publishEvent.bind(this),
            };
            const end_time = Date.now();
            const total_time = (end_time - start_time) / 1000;
            const time_in_seconds = total_time.toFixed();
            console.log(`received response from request/rpc:`, { start_time, end_time, total_time, time_in_seconds, messageObj, options });
            resolve(messageObj);
            this.channel.cancel(consumerTag).then(() => {
              console.log(`removed consumer via consumerTag; deleting temporary queue ${temporaryRpcQueue}...`);
              this.channel.deleteQueue(temporaryRpcQueue, { ifEmpty: true, ifUnused: true })
              .then(() => {
                console.log(`temp queue deleted: ${temporaryRpcQueue}`);
              })
              .catch((error) => {
                console.log(`could not delete temp queue ${temporaryRpcQueue}`);
              });
            });
          }
        };
    
        this.channel.consume(temporaryRpcQueue, replyHandler, { consumerTag });
      });
    };

    return { watch, send };
  }

  sendRequest <T = any> (options: {
    queue: string,
    data: any,
    publishOptions: Options.Publish,
  }) {
    console.log(`sendRequest:`, options);

    return new Promise<RmqEventMessage<T>>(async (resolve, reject) => {
      
      const temporaryRpcQueue = uuidv1();

      const newQueue = await this.channel.assertQueue(temporaryRpcQueue, { exclusive: true, durable: false, autoDelete: true }).then((response) => {
        console.log(`Created temp queue ${temporaryRpcQueue} for client.`);
        return response;
      });

      const rpc = this.getRpcMethods(temporaryRpcQueue, options);

      if (!this.isReady) {
        console.log(`waiting until ready to send request`);
        firstValueFrom(this.onReady).then((readyState) => {
          console.log(`now ready and watching temp queue`, { readyState });
          rpc.watch<T>().then((message: RmqEventMessage<T>) => {
            resolve(message);
          }); // first listen on the reply queue
          console.log(`sending request`);
          rpc.send(); // then send the rpc/rmq message
        });
      }
      else {
        console.log(`now ready and watching temp queue`);
        rpc.watch<T>().then((message: RmqEventMessage<T>) => {
          resolve(message);
        }); // first listen on the reply queue
        console.log(`sending request`);
        rpc.send(); // then send the rpc/rmq message
      }
    });
  }

  publishEvent(options: RmqPublishEventParams) {
    const publish = () => {
      const { data, routingKey, publishOptions, exchange } = options;
      const useContentType = publishOptions.contentType || ContentTypes.TEXT;
      const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].serialize(data) : data;
      this.channel.publish(exchange, routingKey || '', useData, { ...publishOptions, appId: publishOptions.appId });
    };

    if (!this.isReady) {
      console.log(`wait until ready to publish event`);
      this.onReady.subscribe({
        next: () => {
          console.log(`now ready to publish event`);
          publish();
        }
      });
    }
    else {
      console.log(`is ready to publish event`);
      publish();
    }
  }
}
