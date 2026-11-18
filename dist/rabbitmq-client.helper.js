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
    log(level, ...args) {
        const handler = this.logger[level] || (() => undefined);
        handler(...args);
    }
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
        var _a, _b, _c, _d, _e, _f, _g, _h;
        this.isReady = false;
        this.isReadyStream = new rxjs_1.BehaviorSubject(this.isReady);
        this.connectionErrorStream = new rxjs_1.Subject();
        this.connectionCloseStream = new rxjs_1.Subject();
        this.serializers = {};
        this.reconnectAttempts = 0;
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
        this.registeredQueueConsumers = [];
        this.metrics = {
            messagesReceived: 0,
            messagesPublished: 0,
            messagesAcked: 0,
            messagesNacked: 0,
            messagesRetried: 0,
            rpcRequests: 0,
            rpcResponses: 0,
            reconnects: 0,
        };
        this.queueToEventHandleMapping = new Map();
        this.queueToEventCallbackMapping = new Map();
        this.clientInitConfig = clientInitConfig;
        this.serializers = Object.assign({}, (clientInitConfig.serializers || {}));
        this.metricsEnabled = !!clientInitConfig.metrics;
        this.logger = {
            debug: (_b = (_a = clientInitConfig.logger) === null || _a === void 0 ? void 0 : _a.debug) !== null && _b !== void 0 ? _b : (() => undefined),
            info: (_d = (_c = clientInitConfig.logger) === null || _c === void 0 ? void 0 : _c.info) !== null && _d !== void 0 ? _d : console.info.bind(console),
            warn: (_f = (_e = clientInitConfig.logger) === null || _e === void 0 ? void 0 : _e.warn) !== null && _f !== void 0 ? _f : console.warn.bind(console),
            error: (_h = (_g = clientInitConfig.logger) === null || _g === void 0 ? void 0 : _g.error) !== null && _h !== void 0 ? _h : console.error.bind(console),
        };
        !clientInitConfig.stopAutoInit && this.init();
    }
    static registerSerializer(contentType, serializer) {
        return (0, utils_1.registerSerializer)(contentType, serializer);
    }
    registerSerializer(contentType, serializer) {
        this.serializers[contentType] = serializer;
        return serializer;
    }
    getSerializer(contentType) {
        const resolvedContentType = contentType
            || this.clientInitConfig.defaultContentType;
        if (!resolvedContentType) {
            return null;
        }
        return this.serializers[resolvedContentType]
            || (0, utils_1.getSerializer)(resolvedContentType)
            || utils_1.SERIALIZERS[resolvedContentType]
            || null;
    }
    getMetrics() {
        return Object.assign({}, this.metrics);
    }
    resubscribeToRegisteredQueues() {
        for (const { queue, options } of this.registeredQueueConsumers) {
            if (this.queueListeners[queue]) {
                this.queueListeners[queue].unsubscribe();
                delete this.queueListeners[queue];
            }
            this.listenToQueue(queue, options);
        }
    }
    scheduleReconnect(reason) {
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
        const { delayStart, connection_url, prefetch, queues, exchanges, bindings, pre_init_promises, post_init_promises } = this.clientInitConfig;
        let retryAttempts = this.clientInitConfig.retryAttempts || 0;
        const retryDelay = this.clientInitConfig.retryDelay || 0;
        const init = () => {
            // creating connection
            this.log('info', 'Attempting connection to Rabbit MQ...');
            return (0, amqplib_1.connect)(connection_url)
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
                const promises = [];
                for (const queueConfig of queues) {
                    const queueListenersMap = new Map();
                    const queueCallbacksMap = new Map();
                    this.queueToEventHandleMapping.set(queueConfig.name, queueListenersMap);
                    this.queueToEventCallbackMapping.set(queueConfig.name, queueCallbacksMap);
                    // by default, create an observable stream on the queue for unidentified/null routing keys
                    queueListenersMap.set(this.DEFAULT_LISTENER_TYPE, new rxjs_1.ReplaySubject());
                    const useHandleMessageTypes = queueConfig.handleMessageTypes || [];
                    for (const messageType of useHandleMessageTypes) {
                        if (typeof messageType === 'string') {
                            queueListenersMap.set(messageType, new rxjs_1.ReplaySubject());
                        }
                        else {
                            const config = messageType;
                            queueCallbacksMap.set(config.messageName, config.callbackHandler);
                        }
                    }
                    promises.push(this.channel.assertQueue(queueConfig.name, queueConfig.options));
                }
                return Promise.all(promises).then((values) => {
                    this.queues = (0, utils_1.mapify)(values, 'queue');
                    this.log('info', 'queues created on channel');
                });
            })
                // assert exchanges
                .then(() => {
                const promises = exchanges.map((config) => this.channel.assertExchange(config.name, config.type, config.options));
                return Promise.all(promises).then(values => {
                    this.exchanges = (0, utils_1.mapify)(values, 'exchange');
                    this.log('info', 'exchanges created on channel');
                });
            })
                // apply bindings
                .then(() => {
                const promises = bindings.map((config) => this.channel.bindQueue(config.queue, config.exchange, config.routingKey));
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
                return (0, utils_1.wait)(retryDelay).then(init);
            });
        };
        return (0, utils_1.wait)(delayStart || 0)
            .then(() => {
            this.log('info', 'Running pre init promises...');
            return Promise.all((pre_init_promises === null || pre_init_promises === void 0 ? void 0 : pre_init_promises.map(p => p instanceof Promise ? p : p())) || []).then(() => {
                this.log('info', 'Done running pre init promises.');
            });
        })
            .then(init)
            .then(() => {
            this.log('info', 'Running post init promises...');
            return Promise.all((post_init_promises === null || post_init_promises === void 0 ? void 0 : post_init_promises.map(p => p instanceof Promise ? p : p())) || []).then(() => {
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
    getQueueListener(queue, options) {
        return () => {
            // callback
            const handleCallback = (message) => {
                var _a, _b;
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
                const messageObj = {
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
                const queueListeners = (_a = this.queueToEventHandleMapping.get(queue)) !== null && _a !== void 0 ? _a : new Map();
                const queueCallbacks = (_b = this.queueToEventCallbackMapping.get(queue)) !== null && _b !== void 0 ? _b : new Map();
                if (!messageType) {
                    // no type key found, push to default stream
                    this.log('debug', `No message type found; pushing to default handler on queue ${queue}`);
                    const defaultListener = queueListeners.get(this.DEFAULT_LISTENER_TYPE);
                    defaultListener === null || defaultListener === void 0 ? void 0 : defaultListener.next(messageObj);
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
                    const callbackHandler = queueCallbacks.get(messageType);
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
                        defaultListener === null || defaultListener === void 0 ? void 0 : defaultListener.next(messageObj);
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
            this.log('debug', `Already Registered messages/events listener for queue: ${queue}`);
            return;
        }
        this.registeredQueueConsumers = this.registeredQueueConsumers.filter((entry) => entry.queue !== queue);
        this.registeredQueueConsumers.push({ queue, options });
        this.log('info', `Registering messages/events listener for queue: ${queue}`);
        const startQueueListener = this.getQueueListener(queue, options);
        this.messagesStreamsByQueue[queue] = new rxjs_1.Subject();
        this.queueListeners[queue] = this.onReady.pipe((0, rxjs_1.tap)((readyState) => {
            startQueueListener();
        }))
            .subscribe({
            next: (readyState) => {
                this.log('info', `Registered: Now listening to messages/events on queue ${queue}...`);
            }
        });
    }
    onQueue(queue, options) {
        // listen for messages on the queue
        this.listenToQueue(queue, options);
        const handle = (messageType) => {
            return this.onReady.pipe((0, rxjs_1.mergeMap)((ready, index) => {
                const queueListeners = this.queueToEventHandleMapping.get(queue);
                if (!(queueListeners === null || queueListeners === void 0 ? void 0 : queueListeners.has(messageType))) {
                    throw new Error(`The provided routing key was not provided during initialization. Please add routing key "${messageType}" in the list of routing keys for the queue config in the constructor.`);
                }
                return queueListeners.get(messageType).asObservable();
            }));
        };
        const handleDefault = () => {
            return this.onReady.pipe((0, rxjs_1.mergeMap)((ready, index) => {
                var _a;
                const queueListeners = this.queueToEventHandleMapping.get(queue);
                return ((_a = queueListeners === null || queueListeners === void 0 ? void 0 : queueListeners.get(this.DEFAULT_LISTENER_TYPE)) !== null && _a !== void 0 ? _a : new rxjs_1.ReplaySubject()).asObservable();
            }));
        };
        const onEvent = (messageType, handler) => {
            return this.onReady
                .pipe((0, rxjs_1.mergeMap)(() => this.messagesStreamsByQueue[queue]))
                .pipe((0, rxjs_1.filter)((event) => event.message.properties.type === messageType))
                .subscribe({ next: (event) => handler(event) });
        };
        const handleAll = (handler) => {
            return this.onReady
                .pipe((0, rxjs_1.mergeMap)(() => this.messagesStreamsByQueue[queue]))
                .subscribe({ next: (event) => handler(event) });
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
        if (this.metricsEnabled) {
            this.metrics.messagesAcked += 1;
        }
        this.log('debug', 'Acknoledged rmq message.');
    }
    nack(message, requeue = true) {
        if (!this.channel) {
            return;
        }
        this.channel.nack(message, false, requeue);
        if (this.metricsEnabled) {
            this.metrics.messagesNacked += 1;
        }
        this.log('debug', `Nacknowledged rmq message with requeue=${requeue}.`);
    }
    retryMessage(message, options = {}) {
        const { delayMs = 0, requeue = true, queue = '' } = options;
        const targetQueue = queue || message.fields.routingKey || '';
        if (delayMs > 0) {
            setTimeout(() => {
                if (targetQueue) {
                    this.channel.sendToQueue(targetQueue, message.content, Object.assign({ persistent: true }, message.properties));
                }
            }, delayMs);
        }
        else if (targetQueue) {
            this.channel.sendToQueue(targetQueue, message.content, Object.assign({ persistent: true }, message.properties));
        }
        this.nack(message, requeue);
        if (this.metricsEnabled) {
            this.metrics.messagesRetried += 1;
        }
    }
    deadLetter(message, reason, queue) {
        const targetQueue = queue || `${message.fields.routingKey || 'dead-letter'}.dlq`;
        const headers = Object.assign(Object.assign({}, (message.properties.headers || {})), { 'x-death-reason': reason });
        this.channel.sendToQueue(targetQueue, message.content, Object.assign(Object.assign({}, message.properties), { headers, persistent: true }));
        this.nack(message, false);
    }
    setupDeadLetterQueue(config) {
        return __awaiter(this, void 0, void 0, function* () {
            const { sourceQueue, deadLetterQueue = `${sourceQueue}.dlq`, deadLetterExchange = `${sourceQueue}.dlx`, deadLetterRoutingKey = deadLetterQueue, queueOptions = {}, deadLetterQueueOptions = { durable: true }, maxLength, messageTtlMs, } = config;
            const dlxArguments = Object.assign(Object.assign({}, (maxLength ? { 'x-max-length': maxLength } : {})), (messageTtlMs ? { 'x-message-ttl': messageTtlMs } : {}));
            yield this.channel.assertExchange(deadLetterExchange, 'direct', { durable: true });
            yield this.channel.assertQueue(deadLetterQueue, Object.assign(Object.assign({ durable: true }, deadLetterQueueOptions), { arguments: Object.assign(Object.assign({}, (deadLetterQueueOptions.arguments || {})), dlxArguments) }));
            yield this.channel.bindQueue(deadLetterQueue, deadLetterExchange, deadLetterRoutingKey);
            const sourceQueueArguments = Object.assign(Object.assign({}, (queueOptions.arguments || {})), { 'x-dead-letter-exchange': deadLetterExchange, 'x-dead-letter-routing-key': deadLetterRoutingKey });
            yield this.channel.assertQueue(sourceQueue, Object.assign(Object.assign({}, queueOptions), { arguments: sourceQueueArguments }));
            return {
                sourceQueue,
                deadLetterQueue,
                deadLetterExchange,
                deadLetterRoutingKey,
            };
        });
    }
    handleMessageError(message, error, options = {}) {
        var _a, _b;
        const { reason = error instanceof Error ? error.message : 'unknown_error', requeue = false, deadLetterQueue, deadLetterExchange, deadLetterRoutingKey, retryQueue, retryDelayMs, loggerMessage = 'RabbitMQ message processing failed', } = options;
        this.log('error', loggerMessage, {
            reason,
            error,
            routingKey: (_a = message === null || message === void 0 ? void 0 : message.fields) === null || _a === void 0 ? void 0 : _a.routingKey,
            queue: (_b = message === null || message === void 0 ? void 0 : message.fields) === null || _b === void 0 ? void 0 : _b.routingKey,
        });
        if (retryQueue && retryDelayMs && retryDelayMs > 0) {
            const targetQueue = retryQueue;
            setTimeout(() => {
                if (this.channel) {
                    this.channel.sendToQueue(targetQueue, message.content, Object.assign(Object.assign({}, message.properties), { persistent: true }));
                }
            }, retryDelayMs);
            this.nack(message, false);
            return { action: 'retry', targetQueue, retryDelayMs };
        }
        if (deadLetterQueue || deadLetterExchange || deadLetterRoutingKey) {
            const targetQueue = deadLetterQueue || `${message.fields.routingKey || 'dead-letter'}.dlq`;
            this.deadLetter(message, reason, targetQueue);
            return { action: 'dead-letter', targetQueue };
        }
        this.nack(message, requeue);
        return { action: 'nack', requeue };
    }
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = undefined;
            }
            if (this.channel) {
                yield this.channel.close();
            }
            if (this.connection) {
                yield this.connection.close();
            }
            this.isReady = false;
            this.isReadyStream.next(false);
            this.log('info', 'RabbitMQ client closed.');
        });
    }
    sendMessage(options) {
        const send = () => {
            const { data, publishOptions, queue } = options;
            const useContentType = publishOptions.contentType || this.clientInitConfig.defaultContentType || enums_1.ContentTypes.TEXT;
            const serializer = this.getSerializer(useContentType);
            const useData = serializer
                ? serializer.serialize(data)
                : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
            if (this.metricsEnabled) {
                this.metrics.messagesPublished += 1;
            }
            this.channel.sendToQueue(queue, useData, Object.assign(Object.assign({}, publishOptions), { appId: publishOptions.appId }));
        };
        if (!this.isReady) {
            this.log('debug', 'wait until ready to send message...');
            (0, rxjs_1.firstValueFrom)(this.onReady).then((readyState) => {
                this.log('debug', 'now ready to send message', { readyState });
                send();
            });
        }
        else {
            this.log('debug', 'is ready to send message');
            send();
        }
    }
    getRpcMethods(temporaryRpcQueue, options, autoAckOnReceiveReply, requestTimeoutMs) {
        var _a;
        const start_time = Date.now();
        const consumerTag = (0, utils_1.uniqueValue)();
        const correlationId = options.publishOptions.correlationId || (0, uuid_1.v4)();
        const timeoutMs = (_a = requestTimeoutMs !== null && requestTimeoutMs !== void 0 ? requestTimeoutMs : this.clientInitConfig.rpcRequestTimeoutMs) !== null && _a !== void 0 ? _a : 30000;
        const send = () => {
            const { data, publishOptions, queue } = options;
            const useContentType = publishOptions.contentType || this.clientInitConfig.defaultContentType || enums_1.ContentTypes.TEXT;
            const serializer = this.getSerializer(useContentType);
            const useData = serializer
                ? serializer.serialize(data)
                : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
            if (this.metricsEnabled) {
                this.metrics.rpcRequests += 1;
            }
            this.channel.sendToQueue(queue, useData, Object.assign(Object.assign({}, publishOptions), { correlationId, replyTo: temporaryRpcQueue, appId: publishOptions.appId }));
        };
        const watch = () => {
            return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                let settled = false;
                let timeoutHandle;
                const cleanup = () => __awaiter(this, void 0, void 0, function* () {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                    }
                    try {
                        yield this.channel.cancel(consumerTag);
                    }
                    catch (error) {
                        this.log('debug', 'Ignoring cancel failure for RPC consumer', { consumerTag, error });
                    }
                });
                timeoutHandle = setTimeout(() => __awaiter(this, void 0, void 0, function* () {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    yield cleanup();
                    reject(new Error(`RabbitMQ request timed out after ${timeoutMs}ms for correlationId ${correlationId}`));
                }), timeoutMs);
                this.log('debug', 'request/rpc sent; awaiting response...', { correlationId, consumerTag, temporaryRpcQueue });
                const replyHandler = (message) => {
                    if (!message || settled) {
                        return;
                    }
                    this.log('debug', 'Received reply.', { message });
                    const correlationIdMatch = message.properties.correlationId == correlationId;
                    const isReplyToRequest = !!message && correlationIdMatch;
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
                        const messageObj = {
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
            }));
        };
        return { watch, send };
    }
    sendRequest(options, autoAckOnReceiveReply = true, timeoutMs) {
        this.log('debug', 'sendRequest:', options);
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            const temporaryRpcQueue = (0, uuid_1.v1)();
            const newQueue = yield this.channel.assertQueue(temporaryRpcQueue, { exclusive: true, durable: false, autoDelete: true }).then((response) => {
                this.log('debug', `Created temp queue ${temporaryRpcQueue} for client.`);
                return response;
            });
            const rpc = this.getRpcMethods(temporaryRpcQueue, options, autoAckOnReceiveReply, timeoutMs);
            if (!this.isReady) {
                this.log('debug', 'waiting until ready to send request');
                (0, rxjs_1.firstValueFrom)(this.onReady).then((readyState) => {
                    this.log('debug', 'now ready and watching temp queue', { readyState });
                    rpc.watch().then((message) => {
                        resolve(message);
                    }).catch(reject); // first listen on the reply queue
                    this.log('debug', 'sending request');
                    rpc.send(); // then send the rpc/rmq message
                }).catch(reject);
            }
            else {
                this.log('debug', 'now ready and watching temp queue');
                rpc.watch().then((message) => {
                    resolve(message);
                }).catch(reject); // first listen on the reply queue
                this.log('debug', 'sending request');
                rpc.send(); // then send the rpc/rmq message
            }
        }));
    }
    publishEvent(options) {
        const publish = () => {
            const { data, routingKey, publishOptions, exchange } = options;
            const useContentType = publishOptions.contentType || this.clientInitConfig.defaultContentType || enums_1.ContentTypes.TEXT;
            const serializer = this.getSerializer(useContentType);
            const useData = serializer
                ? serializer.serialize(data)
                : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
            if (this.metricsEnabled) {
                this.metrics.messagesPublished += 1;
            }
            this.channel.publish(exchange, routingKey || '', useData, Object.assign(Object.assign({}, publishOptions), { appId: publishOptions.appId }));
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
exports.RabbitMQClient = RabbitMQClient;
//# sourceMappingURL=rabbitmq-client.helper.js.map