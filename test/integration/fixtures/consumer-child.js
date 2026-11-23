'use strict';
// Child process for the SIGKILL test. Consumes a message, reports it to the parent and, in
// 'before-republish' mode, never settles it: the parent SIGKILLs it between receive and republish.
const { RabbitMQClient } = require('../../../dist/cjs');

const [url, queue, mode] = process.argv.slice(2);
const client = new RabbitMQClient({
  connection_url: url,
  topology: 'none',
  prefetch: 1,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

client.onQueue(queue).handleAll(async (event) => {
  process.send({ type: 'received', body: String(event.data), redelivered: event.message.fields.redelivered });
  if (mode === 'before-republish') {
    await new Promise(() => {}); // stuck between receive and republish
  }
});

client.onReady.subscribe(() => process.send({ type: 'ready' }));
