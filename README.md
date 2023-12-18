# RxJS RabbitMQ Client



```typescript
import {
  RabbitMQClient,
  RmqEventMessage
} from "rxjs-rabbitmq";

const handleMessageTypes: string[] = [
  ClientsQueueMessageTypes.ADD_CLIENT,
  UsersQueueEventTypes.USER_CREATED,
  UsersQueueEventTypes.USER_DELETED,
  AuthoritiesQueueEventTypes.AUTHORITY_CREATED,
  AuthoritiesQueueEventTypes.AUTHORITY_DELETED,
];

const rmqClient = new RabbitMQClient({
  connection_url: AppEnvironment.RABBIT_MQ_URL,
  delayStart: 5000,
  prefetch: 5,
  retryAttempts: 3,
  retryDelay: 3000,
  autoAckUnhandledMessageTypes: true,
  queues: [
    { name: MicroservicesQueues.EMAILS, handleMessageTypes, options: { durable: true } },
  ],
  exchanges: [
    { name: MicroservicesExchanges.EMAIL_EVENTS, type: 'fanout', options: { durable: true } },
    { name: MicroservicesExchanges.USER_EVENTS, type: 'fanout', options: { durable: true } },
    { name: MicroservicesExchanges.AUTHORITY_EVENTS, type: 'fanout', options: { durable: true } },
  ],
  bindings: [
    { queue: MicroservicesQueues.EMAILS, exchange: MicroservicesExchanges.USER_EVENTS, routingKey: RoutingKeys.EVENT },
    { queue: MicroservicesQueues.EMAILS, exchange: MicroservicesExchanges.AUTHORITY_EVENTS, routingKey: RoutingKeys.EVENT },
  ]
});



const emailsQueue = rmqClient.onQueue(MicroservicesQueues.EMAILS);

emailsQueue.handle(EmailsQueueMessageTypes.SEND_EMAIL).subscribe({
  next: (event: RmqEventMessage) => SEND_EMAIL(event, rmqClient)
});

emailsQueue.handle(UsersQueueEventTypes.USER_CREATED).subscribe({
  next: (event: RmqEventMessage) => USER_CREATED(event, rmqClient)
});

emailsQueue.handle(UsersQueueEventTypes.USER_DELETED).subscribe({
  next: (event: RmqEventMessage) => USER_DELETED(event, rmqClient)
});



/**
 * Send arbitrary emails via given arguments
 * 
 * @param event 
 * @param rmqClient 
 * @returns {void}
 */
export async function SEND_EMAIL(event: RmqEventMessage, rmqClient: RabbitMQClient) {
  console.log(`[${EmailsQueueMessageTypes.SEND_EMAIL}] Received message:`, { data: event.data });

  const sendEmailParams = event.data as SendEmailDto;

  const email_send_results: SendEmailCommandOutput = await sendAwsEmail({
    to: sendEmailParams.to_email,
    subject: sendEmailParams.subject,
    message: sendEmailParams.text,
    html: sendEmailParams.html,
  });

  const serviceMethodResults: ServiceMethodResults = {
    status: HttpStatusCode.OK,
    error: false,
    info: {
      data: email_send_results
    }
  };
  
  rmqClient.ack(event.message);
  return rmqClient.publishEvent({
    exchange: MicroservicesExchanges.EMAIL_EVENTS,
    routingKey: RoutingKeys.EVENT,
    data: serviceMethodResults,
    publishOptions: {
      type: EmailsQueueEventTypes.SENT_EMAIL,
      contentType: ContentTypes.JSON,
      correlationId: event.message.properties.correlationId,
      replyTo: event.message.properties.replyTo,
    }
  });
}

```