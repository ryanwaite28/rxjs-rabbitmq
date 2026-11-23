// An ESM consumer compiled with NodeNext + verbatimModuleSyntax + exactOptionalPropertyTypes +
// noUncheckedIndexedAccess (see test/tsconfig.esm.json), mirroring a strict production service.
import rxjsRabbitmq, { RabbitMQClient, PublishNackedError, TopologyVerificationError } from 'rxjs-rabbitmq';
import type { ClientState, RmqEventMessage, RabbitMqInitConfig } from 'rxjs-rabbitmq';

type Queue = 'app.q';
type Exchange = 'app.ex' | 'app.retry' | 'app.dlx';
type Key = `app.${string}`;

const config: RabbitMqInitConfig<Queue, Exchange, Key> = {
  connection_url: { hostname: 'localhost', username: 'svc', password: 'secret' },
  socketOptions: { clientProperties: { connection_name: 'svc' } },
  topology: 'verify',
  confirm: true,
  prefetch: 16,
  queues: [{ name: 'app.q' }],
  exchanges: [{ name: 'app.ex', type: 'topic' }],
};

const client = new RabbitMQClient<Queue, Exchange, Key>(config);
const alsoClient: typeof RabbitMQClient = rxjsRabbitmq.RabbitMQClient;
void alsoClient;

async function handle(event: RmqEventMessage<unknown, Queue, Exchange, Key>): Promise<void> {
  const retryCount = event.message.properties.headers?.['x-retry-count'];
  const count = typeof retryCount === 'number' ? retryCount : 0;
  await event.republish({
    exchange: 'app.retry',
    routingKey: `app.${event.queue}.retry.1s`,
    headers: { 'x-retry-count': count + 1 },
  });
}

client.onQueue('app.q').handleAll(handle);

export async function main(): Promise<void> {
  try {
    await client.init();
  }
  catch (error: unknown) {
    if (error instanceof TopologyVerificationError) {
      const missing: string = error.resource;
      void missing;
    }
    throw error;
  }

  try {
    await client.publishEvent({ exchange: 'app.ex', routingKey: 'app.created', data: { id: 1 }, publishOptions: { persistent: true, mandatory: true } });
  }
  catch (error: unknown) {
    if (error instanceof PublishNackedError) {
      const exchange: string = error.exchange;
      void exchange;
    }
  }

  const ready = (): boolean => client.state === 'ready';
  const state: ClientState = client.state;
  void ready;
  void state;

  process.once('SIGTERM', () => {
    void client.close({ drainTimeoutMs: 20_000 });
  });
}
