// Compile-time tests for the generic resource/payload typing (CJS consumer).
// Checked with test/tsconfig.json against the published declarations.
import { RabbitMQClient, type RmqEventMessage, PublishReturnedError, type RmqClientErrorEvent, type ClientState } from 'rxjs-rabbitmq';

type Payloads = {
  SEND_EMAIL: { to: string; subject: string };
  EMAIL_SENT: { ok: boolean };
};

const client = new RabbitMQClient<
  'emails' | 'jobs',
  'app.events' | 'app.retry',
  '#' | 'email.sent' | 'job.created' | `${string}.retry.${string}`,
  'SEND_EMAIL' | 'EMAIL_SENT',
  Payloads
>({
  stopAutoInit: true,
  connection_url: 'amqp://localhost',
  topology: 'verify',
  confirm: true,
  retryAttempts: 0,
  retryDelay: 1000,
  hooks: {
    onPublish: (properties) => {
      properties.headers.traceparent = '00-abc-def-01';
    },
    onDeliver: (event) => {
      const queue: 'emails' | 'jobs' = event.queue;
      void queue;
    },
  },
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
  void event.republish({
    exchange: 'app.retry',
    routingKey: 'emails.retry.5s',
    headers: { 'x-retry-count': 1 },
  });
});

client.onQueue('emails').onEvent('EMAIL_SENT', (event) => {
  const ok: boolean = event.data.ok;
  void ok;
});

client.onQueue('jobs').handleAll(async (event) => {
  await event.republish({ exchange: 'app.events', routingKey: 'job.created' });
});

const sent: Promise<void> = client.sendMessage({
  queue: 'emails',
  data: { to: 'user@example.com', subject: 'Hello' },
  publishOptions: { contentType: 'application/json' }
});
void sent;

client.publishEvent({
  exchange: 'app.events',
  routingKey: 'email.sent',
  data: { to: 'user@example.com', subject: 'Hello' },
  publishOptions: { contentType: 'application/json', mandatory: true }
}).catch((error: unknown) => {
  if (error instanceof PublishReturnedError) {
    const code: number = error.replyCode;
    void code;
  }
});

const state: ClientState = client.state;
void state;
client.errors$.subscribe((event: RmqClientErrorEvent) => {
  if (event.type === 'consumer-cancelled') {
    const queue: string = event.queue;
    void queue;
  }
});
void client.stopConsuming('emails');
void client.close({ drainTimeoutMs: 20_000 });

// @ts-expect-error unknown queue names must be rejected
client.onQueue('unknown');

// @ts-expect-error unknown message types must be rejected
client.onQueue('emails').handle('UNKNOWN_EVENT');

void client.publishEvent({
  // @ts-expect-error unknown exchanges must be rejected
  exchange: 'unknown.exchange',
  data: {},
  publishOptions: {}
});

void client.publishEvent({
  exchange: 'app.events',
  // @ts-expect-error unknown routing keys must be rejected
  routingKey: 'unknown.route',
  data: {},
  publishOptions: {}
});

// @ts-expect-error unknown queue names must be rejected by stopConsuming
void client.stopConsuming('unknown');

new RabbitMQClient({
  connection_url: 'amqp://localhost',
  // @ts-expect-error invalid topology modes must be rejected
  topology: 'create',
});

void (null as unknown as RmqEventMessage<Payloads['SEND_EMAIL']>);
