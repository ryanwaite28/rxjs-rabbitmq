import { Connection, Channel, Options, ConsumeMessage } from "amqplib";
import { Observable, Subscription } from "rxjs";
import { RabbitMqInitConfig, RmqEventHandler, RmqEventMessage, RmqPublishEventParams, RmqSendMessageParams } from "./types";
export type RmgOnEventHandler = (event: RmqEventMessage, rmqClient?: RabbitMQClient) => void;
/**
  Rabbit MQ - RxJS Powered
*/
export declare class RabbitMQClient {
    private clientInitConfig;
    private connection;
    private channel;
    private isReady;
    private isReadyStream;
    private connectionErrorStream;
    private connectionCloseStream;
    private messagesStream;
    private messagesStreamsByQueue;
    private queues;
    private exchanges;
    private bindings;
    private DEFAULT_LISTENER_TYPE;
    private EXCLUSIVE_QUEUE;
    private queueListeners;
    private queueToEventHandleMapping;
    private queueToEventCallbackMapping;
    get onReady(): Observable<boolean>;
    get onConnectionError(): Observable<any>;
    get onConnectionClose(): Observable<any>;
    get onMessage(): Observable<RmqEventMessage>;
    constructor(clientInitConfig: RabbitMqInitConfig);
    init(clientInitConfig: RabbitMqInitConfig): Promise<void>;
    getConnection(): Observable<Connection>;
    getChannel(): Observable<Channel>;
    private getQueueListener;
    private listenToQueue;
    onQueue(queue: string, options?: Options.Consume): {
        handle: (messageType: string) => Observable<RmqEventMessage>;
        handleDefault: () => Observable<RmqEventMessage>;
        onEvent: (messageType: string, handler: RmqEventHandler) => Subscription;
    };
    forQueue(queue: string, options?: Options.Consume): Observable<RmqEventMessage>;
    ack(message: ConsumeMessage): void;
    sendMessage(options: RmqSendMessageParams): Promise<unknown>;
    sendRequest<T = any>(options: {
        queue: string;
        data: any;
        publishOptions: Options.Publish;
    }): Promise<RmqEventMessage<T>>;
    publishEvent(options: RmqPublishEventParams): void;
}
