import { Options, ConsumeMessage, Message } from "amqplib";
/**
    
  */
export type MapType<T = any> = {
    [key: string]: T;
};
export type RmqMessageTypeHandler = (event: RmqEventMessage) => Promise<void>;
export type RmqHandleMessageTypeConfig = {
    messageName: string;
    callbackHandler: RmqMessageTypeHandler;
};
export type RmqHandleMessageTypeConfigs = string[] | RmqHandleMessageTypeConfig[];
export type ExchangeType = 'direct' | 'topic' | 'headers' | 'fanout';
export interface QueueConfig {
    /**
      The name of the queue you want to consume messages from
    */
    name: string;
    /**
      the events to handle on the queue via the message.properties.type value.
      This event name approach is a custom logic, not an official use or convention of message brokers.
      For example, there could be a `USERS` queue with messages of different events
      such as `DELETE_USER` or `CREATE_USER`.
  
      This approach is if you want to consolidate different events into a single queue; it is possible to
      have a dedicated queue for specific events such as a `CREATE_USER` queue, hence why this property is optional.
    */
    handleMessageTypes?: RmqHandleMessageTypeConfigs;
    options?: Options.AssertQueue;
}
/**
  The exchange config.
  An exchange is the means of delivering a message from a producer to a queue for consumers.
  In other words, the post man that delivers mail.

  This is usually defined for a producer to publish event messages
  and how queues are allowed to receive messages from the exchange (based on the exchange type).
*/
export interface ExchangeConfig {
    /**
      The name of the exchange
    */
    name: string;
    /**
      The exchange type.
  
      - `direct`: deliver to queue(s) based on EXACT matching routing key
      - `topic`: deliver to queue(s) based on PATTERN matching routing key
      - `headers`: deliver to queue(s) based on HEADERS
      - `direct`: deliver to queue(s); ignore routing
  
      The `topic` type is the most flexible because it can function as both a `direct` and `fanout`,
      giving consumers more ways to filter the messages from an exchange.
    */
    type: ExchangeType;
    /**
      Other options for exchange
    */
    options?: Options.AssertExchange;
}
/**
  The exchange to queue binding.
  This config determines what queues an exchange will forward messages to.

  It is usually defined for a consumer to request messages from an exchange to a queue they are consuming/listening on
*/
export interface QueueExchangeBindingConfig {
    /**
      The queue for the consumer to receive messages in
    */
    queue: string;
    /**
      The exchange for the consumer to request messages from
    */
    exchange: string;
    /**
      The key for the consumer to filter the messages on
    */
    routingKey: string;
}
export type RmqEventRequestResponse<T = any> = Promise<RmqEventMessage<T>>;
export type RmqSendMessageParams = {
    queue: string;
    data: any;
    publishOptions: Options.Publish;
};
export type RmqSendRequestParams = {
    queue: string;
    data: any;
    publishOptions: Options.Publish;
};
export type RmqPublishEventParams<T = any> = {
    exchange: string;
    data: T;
    routingKey?: string;
    publishOptions: Options.Publish;
};
export type RmqEventMessage<T = any> = {
    data: T;
    message: ConsumeMessage;
    ack: () => void;
    publishEvent: (options: RmqPublishEventParams) => void;
    sendMessage: (options: RmqSendMessageParams) => void;
    sendRequest: <T = any>(options: RmqSendRequestParams) => Promise<RmqEventMessage<T>>;
};
export type RmqEventHandler = (event: RmqEventMessage) => Promise<void>;
export type AckFn = (message: Message) => void;
/**
    
*/
export type RabbitMqInitConfig = {
    /**
      Stop the constructor from automatically initializing the setup process.
      Allows for manually initializing later.
    */
    stopAutoInit?: boolean;
    dontSendToReplyQueueOnPublish?: boolean;
    autoAckUnhandledMessageTypes?: boolean;
    pushUnhandledMessageTypesToDefaultHandler?: boolean;
    delayStart?: number;
    connection_url: string;
    retryAttempts: number;
    retryDelay: number;
    prefetch?: number;
    /**
      The queues to assert on this client
    */
    queues: Array<QueueConfig>;
    /**
      The exchanges to assert on this client
    */
    exchanges: Array<ExchangeConfig>;
    /**
      The bindings to assert on this client
    */
    bindings: Array<QueueExchangeBindingConfig>;
    pre_init_promises?: (Promise<any> | (() => Promise<any>))[];
    post_init_promises?: (Promise<any> | (() => Promise<any>))[];
};
