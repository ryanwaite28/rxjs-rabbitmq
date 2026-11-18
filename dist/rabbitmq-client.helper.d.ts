import { Connection, Channel, Options, ConsumeMessage } from "amqplib";
import { Observable, Subscription } from "rxjs";
import { DeadLetterQueueConfig, HandleMessageErrorOptions, RabbitMqInitConfig, RmqEventHandler, RmqEventMessage, RmqPublishEventParams, RmqSendMessageParams, RmqSendRequestParams, RmqPayloadMap, RmqRetryMessageOptions, RabbitMqSerializer } from "./types";
export type RmgOnEventHandler = (event: RmqEventMessage, rmqClient?: RabbitMQClient) => void;
/**
  Rabbit MQ - RxJS Powered
*/
export declare class RabbitMQClient<QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string, MessageName extends string = string, TPayloadMap extends RmqPayloadMap = RmqPayloadMap> {
    private clientInitConfig;
    private logger;
    private connection;
    private channel;
    private isReady;
    private isReadyStream;
    private connectionErrorStream;
    private connectionCloseStream;
    private reconnectTimeout;
    private serializers;
    private reconnectAttempts;
    private messagesStream;
    private messagesStreamsByQueue;
    private queues;
    private exchanges;
    private bindings;
    private DEFAULT_LISTENER_TYPE;
    private queueListeners;
    private registeredQueueConsumers;
    private metricsEnabled;
    private metrics;
    private queueToEventHandleMapping;
    private queueToEventCallbackMapping;
    private log;
    get onReady(): Observable<boolean>;
    get onConnectionError(): Observable<any>;
    get onConnectionClose(): Observable<any>;
    get onMessage(): Observable<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>;
    constructor(clientInitConfig: RabbitMqInitConfig<QueueName, ExchangeName, RoutingKey, MessageName, TPayloadMap>);
    static registerSerializer(contentType: string, serializer: RabbitMqSerializer): RabbitMqSerializer;
    registerSerializer(contentType: string, serializer: RabbitMqSerializer): RabbitMqSerializer;
    private getSerializer;
    getMetrics(): {
        messagesReceived: number;
        messagesPublished: number;
        messagesAcked: number;
        messagesNacked: number;
        messagesRetried: number;
        rpcRequests: number;
        rpcResponses: number;
        reconnects: number;
    };
    private resubscribeToRegisteredQueues;
    private scheduleReconnect;
    init(): Promise<void>;
    getConnection(): Connection;
    getChannel(): Channel;
    private getQueueListener;
    private listenToQueue;
    onQueue(queue: QueueName, options?: Options.Consume): {
        handle: <TMessageName extends MessageName>(messageType: TMessageName) => Observable<RmqEventMessage<TPayloadMap[TMessageName]>>;
        handleAll: (handler: RmqEventHandler<TPayloadMap[keyof TPayloadMap], QueueName, ExchangeName, RoutingKey>) => Subscription;
        handleDefault: () => Observable<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>;
        onEvent: <TMessageName_1 extends MessageName>(messageType: TMessageName_1, handler: RmqEventHandler<TPayloadMap[TMessageName_1], QueueName, ExchangeName, RoutingKey>) => Subscription;
    };
    forQueue(queue: QueueName, options?: Options.Consume): Observable<RmqEventMessage<unknown, QueueName, ExchangeName, RoutingKey>>;
    ack(message: ConsumeMessage): void;
    nack(message: ConsumeMessage, requeue?: boolean): void;
    retryMessage(message: ConsumeMessage, options?: RmqRetryMessageOptions<QueueName>): void;
    deadLetter(message: ConsumeMessage, reason: string, queue?: string): void;
    setupDeadLetterQueue(config: DeadLetterQueueConfig): Promise<{
        sourceQueue: string;
        deadLetterQueue: string;
        deadLetterExchange: string;
        deadLetterRoutingKey: string;
    }>;
    handleMessageError(message: ConsumeMessage, error: unknown, options?: HandleMessageErrorOptions): {
        action: "retry";
        targetQueue: string;
        retryDelayMs: number;
        requeue?: undefined;
    } | {
        action: "dead-letter";
        targetQueue: string;
        retryDelayMs?: undefined;
        requeue?: undefined;
    } | {
        action: "nack";
        requeue: boolean;
        targetQueue?: undefined;
        retryDelayMs?: undefined;
    };
    close(): Promise<void>;
    sendMessage<T = unknown>(options: RmqSendMessageParams<T, QueueName>): void;
    private getRpcMethods;
    sendRequest<T = unknown>(options: RmqSendRequestParams<unknown, QueueName>, autoAckOnReceiveReply?: boolean, timeoutMs?: number): Promise<RmqEventMessage<T, QueueName, ExchangeName, RoutingKey>>;
    publishEvent<T = unknown>(options: RmqPublishEventParams<T, ExchangeName, RoutingKey>): void;
}
