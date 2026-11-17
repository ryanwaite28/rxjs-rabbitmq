/// <reference types="node" />
import { Connection, Channel, Options, ConsumeMessage } from "amqplib";
import { Observable, Subscription } from "rxjs";
import { DeadLetterQueueConfig, HandleMessageErrorOptions, RabbitMqInitConfig, RmqEventHandler, RmqEventMessage, RmqPublishEventParams, RmqSendMessageParams } from "./types";
export type RmgOnEventHandler = (event: RmqEventMessage, rmqClient?: RabbitMQClient) => void;
/**
  Rabbit MQ - RxJS Powered
*/
export declare class RabbitMQClient {
    private clientInitConfig;
    private logger;
    private connection;
    private channel;
    private isReady;
    private isReadyStream;
    private connectionErrorStream;
    private connectionCloseStream;
    private reconnectTimeout;
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
    get onMessage(): Observable<RmqEventMessage>;
    constructor(clientInitConfig: RabbitMqInitConfig);
    static registerSerializer(contentType: string, serializer: {
        serialize: (value: unknown) => Buffer;
        deserialize: (value: Buffer, encoding?: BufferEncoding) => unknown;
    }): import("./types").RabbitMqSerializer;
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
    onQueue(queue: string, options?: Options.Consume): {
        handle: (messageType: string) => Observable<RmqEventMessage>;
        handleAll: (handler: RmqEventHandler) => Subscription;
        handleDefault: () => Observable<RmqEventMessage>;
        onEvent: (messageType: string, handler: RmqEventHandler) => Subscription;
    };
    forQueue(queue: string, options?: Options.Consume): Observable<RmqEventMessage>;
    ack(message: ConsumeMessage): void;
    nack(message: ConsumeMessage, requeue?: boolean): void;
    retryMessage(message: ConsumeMessage, options?: {
        delayMs?: number;
        requeue?: boolean;
        queue?: string;
    }): void;
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
    sendMessage(options: RmqSendMessageParams): void;
    private getRpcMethods;
    sendRequest<T = any>(options: {
        queue: string;
        data: any;
        publishOptions: Options.Publish;
    }, autoAckOnReceiveReply?: boolean, timeoutMs?: number): Promise<RmqEventMessage<T>>;
    publishEvent(options: RmqPublishEventParams): void;
}
