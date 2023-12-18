import { 
  Options,
  ConsumeMessage,
  Message  
} from "amqplib";

/* 
    
  */


export type MapType<T = any> = { [key:string]: T };

export type RmqMessageTypeHandler = (event: RmqEventMessage) => Promise<void>;
export type RmqHandleMessageTypeConfig = { messageName: string, callbackHandler: RmqMessageTypeHandler };
export type RmqHandleMessageTypeConfigs = string[] | RmqHandleMessageTypeConfig[];

export interface QueueConfig {
  /* 
    The name of the queue you want to consume messages from
  */
  name: string,

  /* 
    the event names 
  */
  handleMessageTypes?: RmqHandleMessageTypeConfigs,

  /* 
    
  */
  options?: Options.AssertQueue
}

export interface ExchangeConfig {
  name: string,
  type: string,
  options?: Options.AssertExchange
}

export interface QueueExchangeBindingConfig {
  queue: string,
  exchange: string,
  routingKey: string
}

export type RmqEventRequestResponse <T = any> = Promise<RmqEventMessage<T>>;

export type RmqSendMessageParams = {
  queue: string,
  data: any,
  publishOptions: Options.Publish
}

export type RmqSendRequestParams = {
  queue: string,
  data: any,
  publishOptions: Options.Publish,
}

export type RmqPublishEventParams<T = any> = {
  exchange: string,
  data: T,
  routingKey: string,
  publishOptions: Options.Publish
}

export type RmqEventMessage<T = any> = {
  data: T,
  message: ConsumeMessage,
  ack: () => void;
  publishEvent: (options: RmqPublishEventParams) => void,
  sendMessage: (options: RmqSendMessageParams) => void,
  sendRequest: <T = any> (options: RmqSendRequestParams) => Promise<RmqEventMessage<T>>,
};

export type AckFn = (message: Message) => void;

export type RabbitMqInitConfig = {
  stopAutoInit?: boolean,
  dontSendToReplyQueueOnPublish?: boolean,
  autoAckUnhandledMessageTypes?: boolean,
  pushUnhandledMessageTypesToDefaultHandler?: boolean,
  delayStart?: number,
  connection_url: string,
  retryAttempts: number,
  retryDelay: number
  prefetch?: number,

  /**
    The queues you want to consume on this client 
  */
  queues: Array<QueueConfig>,
  exchanges: Array<ExchangeConfig>,
  bindings: Array<QueueExchangeBindingConfig>,

  pre_init_promises?: (Promise<any> | (() => Promise<any>))[],
  post_init_promises?: (Promise<any> | (() => Promise<any>))[],
};