/// <reference types="node" />
import { Options, ConsumeMessage, Message } from "amqplib";
/**
    
  */
export type MapType<T = any> = {
    [key: string]: T;
};
export type RmqPayloadMap = Record<string, unknown>;
export type RmqMessageTypeHandler<TPayload = unknown, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = (event: RmqEventMessage<TPayload, QueueName, ExchangeName, RoutingKey>) => Promise<void> | void;
export type RmqHandleMessageTypeConfig<MessageName extends string = string, TPayload = unknown, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = {
    messageName: MessageName;
    callbackHandler: RmqMessageTypeHandler<TPayload, QueueName, ExchangeName, RoutingKey>;
};
export type RmqHandleMessageTypeConfigs<MessageName extends string = string, TPayloadMap extends RmqPayloadMap = RmqPayloadMap, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = readonly (MessageName | RmqHandleMessageTypeConfig<MessageName, TPayloadMap[MessageName], QueueName, ExchangeName, RoutingKey>)[];
export type ExchangeType = 'direct' | 'topic' | 'headers' | 'fanout';
export type RmqPayload = unknown;
export interface QueueConfig<QueueName extends string = string, MessageName extends string = string, TPayloadMap extends RmqPayloadMap = RmqPayloadMap> {
    /**
      The name of the queue you want to consume messages from
    */
    name: QueueName;
    /**
      the events to handle on the queue via the message.properties.type value.
      This event name approach is a custom logic, not an official use or convention of message brokers.
      For example, there could be a `USERS` queue with messages of different events
      such as `DELETE_USER` or `CREATE_USER`.
  
      This approach is if you want to consolidate different events into a single queue; it is possible to
      have a dedicated queue for specific events such as a `CREATE_USER` queue, hence why this property is optional.
    */
    handleMessageTypes?: RmqHandleMessageTypeConfigs<MessageName, TPayloadMap, QueueName, string, string>;
    options?: Options.AssertQueue;
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
    name: ExchangeName;
    /**
      The exchange type.
  
      - `direct`: deliver to queue(s) based on EXACT matching routing key
      - `topic`: deliver to queue(s) based on PATTERN matching routing key
      - `headers`: deliver to queue(s) based on HEADERS
      - `fanout`: deliver to all bound queues
    */
    type: ExchangeType;
    options?: Options.AssertExchange;
}
/**
  The exchange to queue binding.
  This config determines what queues an exchange will forward messages to.

  It is usually defined for a consumer to request messages from an exchange to a queue they are consuming/listening on
*/
export interface QueueExchangeBindingConfig<QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> {
    /**
      The queue for the consumer to receive messages in
    */
    queue: QueueName;
    /**
      The exchange for the consumer to request messages from
    */
    exchange: ExchangeName;
    /**
      The key for the consumer to filter the messages on
    */
    routingKey: RoutingKey;
}
export type DeadLetterQueueConfig = {
    sourceQueue: string;
    deadLetterQueue?: string;
    deadLetterExchange?: string;
    deadLetterRoutingKey?: string;
    queueOptions?: Options.AssertQueue;
    deadLetterQueueOptions?: Options.AssertQueue;
    maxLength?: number;
    messageTtlMs?: number;
};
export type HandleMessageErrorOptions = {
    reason?: string;
    requeue?: boolean;
    deadLetterQueue?: string;
    deadLetterExchange?: string;
    deadLetterRoutingKey?: string;
    retryQueue?: string;
    retryDelayMs?: number;
    loggerMessage?: string;
};
export type RmqEventRequestResponse<T = any> = Promise<RmqEventMessage<T>>;
export type RmqSendMessageParams<T = unknown, QueueName extends string = string> = {
    queue: QueueName;
    data: T;
    publishOptions: Options.Publish;
};
export type RmqSendRequestParams<T = unknown, QueueName extends string = string> = {
    queue: QueueName;
    data: T;
    publishOptions: Options.Publish;
};
export type RmqPublishEventParams<T = unknown, ExchangeName extends string = string, RoutingKey extends string = string> = {
    exchange: ExchangeName;
    data: T;
    routingKey?: RoutingKey;
    publishOptions: Options.Publish;
};
export type RmqRetryMessageOptions<QueueName extends string = string> = {
    delayMs?: number;
    requeue?: boolean;
    queue?: QueueName;
};
export type RmqEventMessage<T = unknown, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = {
    data: T;
    message: ConsumeMessage;
    ack: () => void;
    nack: (requeue?: boolean) => void;
    retry: (options?: RmqRetryMessageOptions<QueueName>) => void;
    handlerError: (error: unknown, options?: HandleMessageErrorOptions) => {
        action: 'retry' | 'dead-letter' | 'nack';
        targetQueue?: string;
        retryDelayMs?: number;
        requeue?: boolean;
    };
    publishEvent: <P = unknown>(options: RmqPublishEventParams<P, ExchangeName, RoutingKey>) => void;
    sendMessage: <U = unknown>(options: RmqSendMessageParams<U, QueueName>) => void;
    sendRequest: <U = unknown>(options: RmqSendRequestParams<U, QueueName>) => Promise<RmqEventMessage<U, QueueName, ExchangeName, RoutingKey>>;
};
export type RmqEventHandler<TPayload = unknown, QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string> = (event: RmqEventMessage<TPayload, QueueName, ExchangeName, RoutingKey>) => unknown;
export type AckFn = (message: Message) => void;
export type RabbitMqLogger = {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
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
};
export type RabbitMqSerializer = {
    serialize: (value: unknown) => Buffer;
    deserialize: (value: Buffer, encoding?: BufferEncoding) => unknown;
};
export type RabbitMqSerializerMap = Record<string, RabbitMqSerializer>;
/**
    
*/
export type RabbitMqInitConfig<QueueName extends string = string, ExchangeName extends string = string, RoutingKey extends string = string, MessageName extends string = string, TPayloadMap extends RmqPayloadMap = RmqPayloadMap> = {
    /**
      Stop the constructor from automatically initializing the setup process.
      Allows for manually initializing later.
    */
    stopAutoInit?: boolean;
    dontSendToReplyQueueOnPublish?: boolean;
    autoAckUnhandledMessageTypes?: boolean;
    pushUnhandledMessageTypesToDefaultHandler?: boolean;
    logger?: Partial<RabbitMqLogger>;
    metrics?: boolean;
    rpcRequestTimeoutMs?: number;
    serializers?: RabbitMqSerializerMap;
    defaultContentType?: string;
    delayStart?: number;
    connection_url: string;
    retryAttempts: number;
    retryDelay: number;
    prefetch?: number;
    queues: Array<QueueConfig<QueueName, MessageName, TPayloadMap>>;
    exchanges: Array<ExchangeConfig<ExchangeName>>;
    bindings: Array<QueueExchangeBindingConfig<QueueName, ExchangeName, RoutingKey>>;
    pre_init_promises?: (Promise<any> | (() => Promise<any>))[];
    post_init_promises?: (Promise<any> | (() => Promise<any>))[];
};
