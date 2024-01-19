"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RabbitMQClient = void 0;
const uuid_1 = require("uuid");
const amqplib_1 = require("amqplib");
const rxjs_1 = require("rxjs");
const utils_1 = require("./utils");
const enums_1 = require("./enums");
/**
  Rabbit MQ - RxJS Powered
*/
class RabbitMQClient {
    get onReady() {
        return this.isReadyStream.asObservable().pipe((0, rxjs_1.filter)((state) => !!state), (0, rxjs_1.take)(1));
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
        this.isReadyStream = new rxjs_1.BehaviorSubject(this.isReady);
        this.connectionErrorStream = new rxjs_1.Subject();
        this.connectionCloseStream = new rxjs_1.Subject();
        /*
          Handle all messages from all queues on this client
        */
        this.messagesStream = new rxjs_1.Subject();
        this.messagesStreamsByQueue = {};
        this.queues = {};
        this.exchanges = {};
        this.bindings = [];
        this.DEFAULT_LISTENER_TYPE = '__default';
        this.queueListeners = {};
        this.queueToEventHandleMapping = {};
        this.queueToEventCallbackMapping = {};
        this.clientInitConfig = clientInitConfig;
        !clientInitConfig.stopAutoInit && this.init();
    }
    init() {
        if (this.isReady) {
            console.log(`Already initialized`);
            return;
        }
        const { delayStart, connection_url, prefetch, queues, exchanges, bindings, pre_init_promises, post_init_promises } = this.clientInitConfig;
        let retryAttempts = this.clientInitConfig.retryAttempts || 0;
        const retryDelay = this.clientInitConfig.retryDelay || 0;
        const init = () => {
            // creating connection
            console.log(`Attempting connection to Rabbit MQ...`);
            return (0, amqplib_1.connect)(connection_url)
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
                const promises = [];
                for (const queueConfig of queues) {
                    this.queueToEventHandleMapping[queueConfig.name] = {};
                    this.queueToEventCallbackMapping[queueConfig.name] = {};
                    const queueListenersMap = this.queueToEventHandleMapping[queueConfig.name];
                    const queueCallbacksMap = this.queueToEventCallbackMapping[queueConfig.name];
                    // by default, create an observable stream on the queue for unidentified/null routing keys
                    queueListenersMap[this.DEFAULT_LISTENER_TYPE] = new rxjs_1.ReplaySubject();
                    const useHandleMessageTypes = queueConfig.handleMessageTypes || [];
                    for (const messageType of useHandleMessageTypes) {
                        if (typeof messageType === 'string') {
                            queueListenersMap[messageType] = new rxjs_1.ReplaySubject();
                        }
                        else {
                            const config = messageType;
                            queueCallbacksMap[config.messageName] = config.callbackHandler;
                        }
                    }
                    promises.push(this.channel.assertQueue(queueConfig.name, queueConfig.options));
                }
                return Promise.all(promises).then((values) => {
                    this.queues = (0, utils_1.mapify)(values, 'queue');
                    console.log(`queues created on channel`);
                });
            })
                // assert exchanges
                .then(() => {
                const promises = exchanges.map((config) => this.channel.assertExchange(config.name, config.type, config.options));
                return Promise.all(promises).then(values => {
                    this.exchanges = (0, utils_1.mapify)(values, 'exchange');
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
                return (0, utils_1.wait)(retryDelay).then(init);
            });
        };
        return (0, utils_1.wait)(delayStart || 0)
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
    getQueueListener(queue, options) {
        return () => {
            // callback
            const handleCallback = (message) => {
                if (!message) {
                    // console.log('Consumer cancelled by server');
                    // throw new Error('Consumer cancelled by server');
                    return;
                }
                // console.log(`Received queue message.`, message);
                // see if a listener was created for the routing key
                const messageType = message.properties.type;
                const useContentType = message.properties.contentType;
                const useData = utils_1.SERIALIZERS[useContentType] ? utils_1.SERIALIZERS[useContentType].deserialize(message.content) : message.content;
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
        this.messagesStreamsByQueue[queue] = new rxjs_1.Subject();
        this.queueListeners[queue] = this.onReady.pipe((0, rxjs_1.tap)((readyState) => {
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
            return this.onReady.pipe((0, rxjs_1.mergeMap)((ready, index) => {
                if (!this.queueToEventHandleMapping[queue][messageType]) {
                    throw new Error(`The provided routing key was not provided during initialization. Please add routing key "${messageType}" in the list of routing keys for the queue config in the constructor.`);
                }
                return this.queueToEventHandleMapping[queue][messageType].asObservable();
            }));
        };
        const handleDefault = () => {
            return this.onReady.pipe((0, rxjs_1.mergeMap)((ready, index) => this.queueToEventHandleMapping[queue][this.DEFAULT_LISTENER_TYPE].asObservable()));
        };
        /**
          Providing callback function approach
        */
        const onEvent = (messageType, handler) => {
            return this.onReady
                .pipe((0, rxjs_1.mergeMap)(() => this.messagesStreamsByQueue[queue]))
                .pipe((0, rxjs_1.filter)((event) => event.message.properties.type === messageType))
                .subscribe({ next: handler });
        };
        const handleAll = (handler) => {
            return this.onReady
                .pipe((0, rxjs_1.mergeMap)(() => this.messagesStreamsByQueue[queue]))
                .subscribe({ next: handler });
        };
        return {
            handle,
            handleAll,
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
        const send = () => {
            const { data, publishOptions, queue } = options;
            const useContentType = publishOptions.contentType || enums_1.ContentTypes.TEXT;
            const useData = utils_1.SERIALIZERS[useContentType] ? utils_1.SERIALIZERS[useContentType].serialize(data) : data;
            this.channel.sendToQueue(queue, useData, Object.assign(Object.assign({}, publishOptions), { appId: publishOptions.appId }));
        };
        if (!this.isReady) {
            console.log(`wait until ready to send message...`);
            (0, rxjs_1.firstValueFrom)(this.onReady).then((readyState) => {
                console.log(`now ready to send message`, { readyState });
                send();
            });
        }
        else {
            console.log(`is ready to send message`);
            send();
        }
    }
    getRpcMethods(temporaryRpcQueue, options) {
        const start_time = Date.now();
        const consumerTag = (0, utils_1.uniqueValue)();
        const correlationId = options.publishOptions.correlationId || (0, uuid_1.v4)();
        const send = () => {
            const { data, publishOptions, queue } = options;
            const useContentType = publishOptions.contentType || enums_1.ContentTypes.TEXT;
            const useData = utils_1.SERIALIZERS[useContentType] ? utils_1.SERIALIZERS[useContentType].serialize(data) : data;
            this.channel.sendToQueue(queue, useData, Object.assign(Object.assign({}, publishOptions), { correlationId, replyTo: temporaryRpcQueue, appId: publishOptions.appId }));
        };
        const watch = () => {
            return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                console.log(`request/rpc sent; awaiting response...`, { correlationId, consumerTag, temporaryRpcQueue });
                const replyHandler = (message) => {
                    console.log(`\nReceived reply.\n`, { message });
                    const correlationIdMatch = message.properties.correlationId == correlationId;
                    const isReplyToRequest = !!message && correlationIdMatch;
                    console.log({ isReplyToRequest, consumerTag, correlationIdMatch, requestCorrelationId: correlationId, responseCorrelationId: message.properties.correlationId });
                    if (isReplyToRequest) {
                        const useContentType = message.properties.contentType;
                        const useData = utils_1.SERIALIZERS[useContentType] ? utils_1.SERIALIZERS[useContentType].deserialize(message.content) : message.content;
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
                        // this.channel.cancel(consumerTag).then(() => {
                        //   console.log(`removed consumer via consumerTag; deleting temporary queue ${temporaryRpcQueue}...`);
                        //   this.channel.deleteQueue(temporaryRpcQueue, { ifEmpty: true, ifUnused: true })
                        //   .then(() => {
                        //     console.log(`temp queue deleted: ${temporaryRpcQueue}`);
                        //   })
                        //   .catch((error) => {
                        //     console.log(`could not delete temp queue ${temporaryRpcQueue}`);
                        //   });
                        // });
                    }
                };
                this.channel.consume(temporaryRpcQueue, replyHandler, { consumerTag });
            }));
        };
        return { watch, send };
    }
    sendRequest(options) {
        console.log(`sendRequest:`, options);
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            const temporaryRpcQueue = (0, uuid_1.v1)();
            const newQueue = yield this.channel.assertQueue(temporaryRpcQueue, { exclusive: true, durable: false, autoDelete: true }).then((response) => {
                console.log(`Created temp queue ${temporaryRpcQueue} for client.`);
                return response;
            });
            const rpc = this.getRpcMethods(temporaryRpcQueue, options);
            if (!this.isReady) {
                console.log(`waiting until ready to send request`);
                (0, rxjs_1.firstValueFrom)(this.onReady).then((readyState) => {
                    console.log(`now ready and watching temp queue`, { readyState });
                    rpc.watch().then((message) => {
                        resolve(message);
                    }); // first listen on the reply queue
                    console.log(`sending request`);
                    rpc.send(); // then send the rpc/rmq message
                });
            }
            else {
                console.log(`now ready and watching temp queue`);
                rpc.watch().then((message) => {
                    resolve(message);
                }); // first listen on the reply queue
                console.log(`sending request`);
                rpc.send(); // then send the rpc/rmq message
            }
        }));
    }
    publishEvent(options) {
        const publish = () => {
            const { data, routingKey, publishOptions, exchange } = options;
            const useContentType = publishOptions.contentType || enums_1.ContentTypes.TEXT;
            const useData = utils_1.SERIALIZERS[useContentType] ? utils_1.SERIALIZERS[useContentType].serialize(data) : data;
            this.channel.publish(exchange, routingKey || '', useData, Object.assign(Object.assign({}, publishOptions), { appId: publishOptions.appId }));
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
exports.RabbitMQClient = RabbitMQClient;
//# sourceMappingURL=rabbitmq-client.helper.js.map