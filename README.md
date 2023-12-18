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


// Listen to all messages from a queue
rmqClient.forQueue(MicroservicesQueues.NOTIFICATIONS).subscribe({
  next: (event: RmqEventMessage) => {
    const handler: RmqEventHandler = EventHandlersMap[event.message.properties.type];
    if (!!handler && typeof (handler) === 'function') {
      handler(event);
    }
  }
});



// Handle specific queue
const emailsQueue = rmqClient.onQueue(MicroservicesQueues.EMAILS);

// Handle specific message types from a queue
emailsQueue.handle(EmailsQueueMessageTypes.SEND_EMAIL).subscribe({ next: SEND_EMAIL });

// shorthand/auto-subscribe and handle
emailsQueue.onEvent(EmailsQueueMessageTypes.SEND_EMAIL, SEND_EMAIL);



// event handler

export async function SEND_EMAIL(event: RmqEventMessage) {
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
  
  event.ack(event.message);
  return rmqClient.publishEvent({
    exchange: MicroservicesExchanges.EMAIL_EVENTS,
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