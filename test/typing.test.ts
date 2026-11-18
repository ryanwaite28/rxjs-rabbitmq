import { RabbitMQClient, RmqEventMessage } from '../src';

type Payloads = {
  SEND_EMAIL: { to: string; subject: string };
  EMAIL_SENT: { ok: boolean };
};

const client = new RabbitMQClient<
  'emails' | 'jobs',
  'app.events',
  '#' | 'email.sent' | 'job.created',
  'SEND_EMAIL' | 'EMAIL_SENT',
  Payloads
>({
  stopAutoInit: true,
  connection_url: 'amqp://localhost',
  retryAttempts: 0,
  retryDelay: 1000,
  queues: [{
    name: 'emails',
    handleMessageTypes: [{
      messageName: 'SEND_EMAIL',
      callbackHandler: (event) => {
        const recipient: string = event.data.to;
        void recipient;
      }
    }]
  }],
  exchanges: [{ name: 'app.events', type: 'fanout' }],
  bindings: [{ queue: 'emails', exchange: 'app.events', routingKey: '#' }]
});

client.onQueue('emails').handle('SEND_EMAIL').subscribe((event) => {
  const recipient: string = event.data.to;
  void recipient;
});

client.onQueue('emails').onEvent('EMAIL_SENT', (event) => {
  const ok: boolean = event.data.ok;
  void ok;
});

client.sendMessage({
  queue: 'emails',
  data: { to: 'user@example.com', subject: 'Hello' },
  publishOptions: { contentType: 'application/json' }
});

client.publishEvent({
  exchange: 'app.events',
  routingKey: 'email.sent',
  data: { to: 'user@example.com', subject: 'Hello' },
  publishOptions: { contentType: 'application/json' }
});

// @ts-expect-error unknown queue names must be rejected
client.onQueue('unknown');

// @ts-expect-error unknown message types must be rejected
client.onQueue('emails').handle('UNKNOWN_EVENT');

// @ts-expect-error unknown exchanges must be rejected
client.publishEvent({
  exchange: 'unknown.exchange',
  data: {},
  publishOptions: {}
});

// @ts-expect-error unknown routing keys must be rejected
client.publishEvent({
  exchange: 'app.events',
  routingKey: 'unknown.route',
  data: {},
  publishOptions: {}
});

void (null as unknown as RmqEventMessage<Payloads['SEND_EMAIL']>);
