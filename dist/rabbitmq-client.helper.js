var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { v1 as uuidv1 } from 'uuid';
import { connect } from "amqplib";
import { BehaviorSubject, filter, firstValueFrom, map, mergeMap, ReplaySubject, Subject, take, tap, } from "rxjs";
import { mapify, SERIALIZERS, uniqueValue, wait } from "./utils";
import { ContentTypes } from "./enums";
/**
  Rabbit MQ - RxJS Powered
*/
export class RabbitMQClient {
    get onReady() {
        return this.isReadyStream.asObservable().pipe(filter((state) => !!state), take(1));
    }
    get onConnectionError() {
        return this.connectionErrorStream.asObservable();
    }
    get onConnectionClose() {
        return this.connectionCloseStream.asObservable();
    }
    get onMessage() {
        return this.messagesStream.asObservable();
    }
    constructor(clientInitConfig) {
        this.isReady = false;
        this.isReadyStream = new BehaviorSubject(this.isReady);
        this.connectionErrorStream = new Subject();
        this.connectionCloseStream = new Subject();
        /*
          Handle all messages from all queues on this client
        */
        this.messagesStream = new Subject();
        this.messagesStreamsByQueue = {};
        this.queues = {};
        this.exchanges = {};
        this.bindings = [];
        this.DEFAULT_LISTENER_TYPE = '__default';
        this.EXCLUSIVE_QUEUE = uuidv1();
        this.queueListeners = {};
        this.queueToEventHandleMapping = {};
        this.queueToEventCallbackMapping = {};
        !clientInitConfig.stopAutoInit && this.init(clientInitConfig);
    }
    init(clientInitConfig) {
        this.clientInitConfig = clientInitConfig;
        const { delayStart, connection_url, prefetch, queues, exchanges, bindings, pre_init_promises, post_init_promises } = clientInitConfig;
        let retryAttempts = clientInitConfig.retryAttempts || 0;
        const retryDelay = clientInitConfig.retryDelay || 0;
        const init = () => {
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
                // creating exclusive queue
                .then(() => {
                // create an exclusive queue for this channel connection
                console.log(`Creating exclusive queue ${this.EXCLUSIVE_QUEUE}`);
                return this.channel.assertQueue(this.EXCLUSIVE_QUEUE, { exclusive: true, durable: false }).then((response) => {
                    console.log(`Created exclusive queue ${this.EXCLUSIVE_QUEUE}`);
                });
            })
                // assert to queues
                .then(() => {
                const promises = [];
                for (const queueConfig of queues) {
                    this.queueToEventHandleMapping[queueConfig.name] = {};
                    this.queueToEventCallbackMapping[queueConfig.name] = {};
                    const queueListenersMap = this.queueToEventHandleMapping[queueConfig.name];
                    const queueCallbacksMap = this.queueToEventCallbackMapping[queueConfig.name];
                    // by default, create an observable stream on the queue for unidentified/null routing keys
                    queueListenersMap[this.DEFAULT_LISTENER_TYPE] = new ReplaySubject();
                    const useHandleMessageTypes = queueConfig.handleMessageTypes || [];
                    for (const messageType of useHandleMessageTypes) {
                        const isStringList = typeof messageType === 'string';
                        if (isStringList) {
                            queueListenersMap[messageType] = new ReplaySubject();
                        }
                        else {
                            const config = messageType;
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
                const promises = exchanges.map((config) => this.channel.assertExchange(config.name, config.type, config.options));
                return Promise.all(promises).then(values => {
                    this.exchanges = mapify(values, 'exchange');
                    console.log(`exchanges created on channel`);
                });
            })
                // apply bindings
                .then(() => {
                const promises = bindings.map((config) => this.channel.bindQueue(config.queue, config.exchange, config.routingKey));
                // bind the exclusive queue to all the exchanges
                // const exclusiveBindings = bindings.map((config) => this.channel.bindQueue(this.EXCLUSIVE_QUEUE, config.exchange, config.routingKey));
                return Promise.all(promises).then(values => {
                    console.log(`bindings created on channel`);
                });
            })
                .then(() => {
                console.log(`Client initialization complete; waiting for messages/events...\n`);
                // initialization complete; listen for connection issues to retry again
                retryAttempts = clientInitConfig.retryAttempts;
                this.connection.on("error", (err) => {
                    this.connectionErrorStream.next(err);
                });
                this.connection.on("close", (err) => {
                    this.connectionErrorStream.next(err);
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
            return Promise.all((pre_init_promises === null || pre_init_promises === void 0 ? void 0 : pre_init_promises.map(p => p instanceof Promise ? p : p())) || []).then(() => {
                console.log(`Done running pre init promises.\n`);
            });
        })
            .then(init)
            .then(() => {
            console.log(`Running post init promises...`);
            return Promise.all((post_init_promises === null || post_init_promises === void 0 ? void 0 : post_init_promises.map(p => p instanceof Promise ? p : p())) || []).then(() => {
                console.log(`Done running post init promises. `);
            });
        });
    }
    getConnection() {
        return this.onReady.pipe(map(() => this.connection));
    }
    getChannel() {
        return this.onReady.pipe(map(() => this.channel));
    }
    getQueueListener(queue, options) {
        return () => {
            const handleCallback = (message) => {
                var _a;
                if (!message) {
                    throw new Error('Consumer cancelled by server');
                }
                console.log(`received queue message`, message);
                // see if a listener was created for the routing key
                const messageType = message.properties.type;
                const useContentType = message.properties.contentType;
                const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].deserialize(message.content) : message.content;
                const messageObj = {
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
                (_a = this.messagesStreamsByQueue[queue]) === null || _a === void 0 ? void 0 : _a.next(messageObj);
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
                        throw new Error(`Message received with unregistered message type handler/callback. Please add message type "${messageType}" in the list of message types for the queue config in the constructor.`);
                    }
                }
            };
            this.channel.consume(queue, handleCallback, Object.assign({}, (options || {})));
        };
    }
    listenToQueue(queue, options) {
        if (this.queueListeners[queue]) {
            console.log(`Already Registered messages/events listener for queue: ${queue}`);
            return;
        }
        console.log(`Registering messages/events listener for queue: ${queue}`);
        const startQueueListener = this.getQueueListener(queue, options);
        this.messagesStreamsByQueue[queue] = new Subject();
        this.queueListeners[queue] = this.onReady.pipe(tap((readyState) => {
            startQueueListener();
        }))
            .subscribe({
            next: (readyState) => {
                console.log(`Registered: Now listening to messages/events on queue ${queue}...`);
            }
        });
    }
    onQueue(queue, options) {
        // listen for messages on the queue
        this.listenToQueue(queue, options);
        const handle = (messageType) => {
            return this.onReady.pipe(mergeMap((ready, index) => {
                if (!this.queueToEventHandleMapping[queue][messageType]) {
                    throw new Error(`The provided routing key was not provided during initialization. Please add routing key "${messageType}" in the list of routing keys for the queue config in the constructor.`);
                }
                return this.queueToEventHandleMapping[queue][messageType].asObservable();
            }));
        };
        const handleDefault = () => {
            return this.onReady.pipe(mergeMap((ready, index) => this.queueToEventHandleMapping[queue][this.DEFAULT_LISTENER_TYPE].asObservable()));
        };
        const onEvent = (messageType, handler) => {
            return this.messagesStreamsByQueue[queue]
                .asObservable()
                .pipe(filter(() => this.isReady))
                .pipe(filter((event) => event.message.properties.type === messageType))
                .subscribe({ next: handler });
        };
        return {
            handle,
            handleDefault,
            onEvent,
        };
    }
    forQueue(queue, options) {
        this.listenToQueue(queue, options);
        return this.messagesStreamsByQueue[queue].asObservable();
    }
    ack(message) {
        this.channel.ack(message);
        console.log(`Acknoledged rmq message.`);
    }
    sendMessage(options) {
        return new Promise((resolve, reject) => {
            const send = () => {
                const { data, publishOptions, queue } = options;
                const useContentType = publishOptions.contentType || ContentTypes.TEXT;
                const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].serialize(data) : data;
                this.channel.sendToQueue(queue, useData, Object.assign(Object.assign({}, publishOptions), { appId: publishOptions.appId }));
                resolve(undefined);
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
        });
    }
    sendRequest(options) {
        console.log(`sendRequest:`, options);
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            const start_time = Date.now();
            const consumerTag = uniqueValue();
            const correlationId = options.publishOptions.correlationId || uniqueValue();
            const temporaryRpcQueue = uuidv1();
            const newQueue = yield this.channel.assertQueue(temporaryRpcQueue, { exclusive: true, durable: false, autoDelete: true }).then((response) => {
                console.log(`Created temp queue ${temporaryRpcQueue} for client.`);
                return response;
            });
            const send = () => {
                const { data, publishOptions, queue } = options;
                const useContentType = publishOptions.contentType || ContentTypes.TEXT;
                const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].serialize(data) : data;
                this.channel.sendToQueue(queue, useData, Object.assign(Object.assign({}, publishOptions), { correlationId, replyTo: temporaryRpcQueue, appId: publishOptions.appId }));
            };
            const watch = () => {
                console.log(`request/rpc sent; awaiting response...`, { correlationId, consumerTag });
                const replyHandler = (message) => {
                    console.log(`\nReceived reply.\n`, { message });
                    const correlationIdMatch = message.properties.correlationId == correlationId;
                    const isReplyToRequest = !!message && correlationIdMatch;
                    console.log({ isReplyToRequest, consumerTag, correlationIdMatch, requestCorrelationId: correlationId, responseCorrelationId: message.properties.correlationId });
                    if (isReplyToRequest) {
                        this.ack(message);
                        const useContentType = message.properties.contentType;
                        const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].deserialize(message.content) : message.content;
                        const messageObj = {
                            data: useData,
                            message: message,
                            ack: () => {
                                this.ack(message);
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
                            console.log(`removed consumer via consumerTag`);
                        });
                    }
                };
                this.channel.consume(temporaryRpcQueue, replyHandler, { consumerTag });
            };
            if (!this.isReady) {
                console.log(`waiting until ready to send request`);
                firstValueFrom(this.onReady).then((readyState) => {
                    console.log(`now ready to publish event`, { readyState });
                    watch(); // first listen on the reply queue
                    send(); // then send the rpc/rmq message
                });
            }
            else {
                console.log(`is ready to send request`);
                watch();
                send();
            }
        }));
    }
    publishEvent(options) {
        const publish = () => {
            const { data, routingKey, publishOptions, exchange } = options;
            const useContentType = publishOptions.contentType || ContentTypes.TEXT;
            const useData = SERIALIZERS[useContentType] ? SERIALIZERS[useContentType].serialize(data) : data;
            this.channel.publish(exchange, routingKey || '', useData, Object.assign(Object.assign({}, publishOptions), { appId: publishOptions.appId }));
            if (publishOptions.replyTo && !this.clientInitConfig.dontSendToReplyQueueOnPublish) {
                console.log(`sending copy to reply to queue ${publishOptions.replyTo}...`);
                this.channel.sendToQueue(publishOptions.replyTo, useData, publishOptions);
            }
        };
        if (!this.isReady) {
            console.log(`wait until ready to publish event`);
            this.onReady.subscribe({
                next: (readyState) => {
                    console.log(`now ready to publish event`, { readyState });
                    readyState && publish();
                }
            });
        }
        else {
            console.log(`is ready to publish event`);
            publish();
        }
    }
}
//# sourceMappingURL=rabbitmq-client.helper.js.map