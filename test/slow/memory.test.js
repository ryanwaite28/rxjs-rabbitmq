'use strict';
// R3: heap stays flat across 100,000 consumed messages. Run with `npm run test:slow` (needs --expose-gc).
const test = require('node:test');
const assert = require('node:assert/strict');
const { RabbitMQClient } = require('../../dist/cjs');
const { startBroker } = require('../helpers/broker');

const TOTAL = Number(process.env.MEMORY_TEST_MESSAGES || 100000);
const WARMUP = 10000;

function heapUsed() {
  for (let i = 0; i < 5; i++) global.gc();
  return process.memoryUsage().heapUsed;
}

test(`R3: heap stays flat (±10%) across ${TOTAL} consumed messages`, { skip: typeof global.gc !== 'function' && 'requires --expose-gc' }, async () => {
  const broker = await startBroker();
  const client = new RabbitMQClient({
    stopAutoInit: true,
    connection_url: broker.url(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    prefetch: 200,
    queues: [{ name: 'mem.q', options: { durable: true } }],
  });
  try {
    await client.init();
    const payload = Buffer.alloc(512, 1);

    let consumed = 0;
    let baseline = 0;
    let resolveWarm;
    let resolveDone;
    const warm = new Promise((resolve) => { resolveWarm = resolve; });
    const done = new Promise((resolve) => { resolveDone = resolve; });
    client.onQueue('mem.q').handle('TICK').subscribe((event) => {
      event.ack();
      consumed += 1;
      if (consumed === WARMUP) resolveWarm();
      if (consumed === TOTAL) resolveDone();
    });

    // publish in confirmed batches so the publisher side is bounded too
    const publishAll = (async () => {
      for (let sent = 0; sent < TOTAL; sent += 1000) {
        await Promise.all(Array.from({ length: Math.min(1000, TOTAL - sent) }, () => client.sendMessage({
          queue: 'mem.q',
          data: payload,
          publishOptions: { type: 'TICK', contentType: 'application/octet-stream' },
        })));
      }
    })();

    await warm;
    baseline = heapUsed();
    await publishAll;
    await done;
    const final = heapUsed();
    const ratio = final / baseline;
    console.log(`heapUsed after ${WARMUP}: ${(baseline / 1048576).toFixed(2)} MiB, after ${TOTAL}: ${(final / 1048576).toFixed(2)} MiB (x${ratio.toFixed(3)})`);
    assert.ok(ratio <= 1.1, `heap grew by ${((ratio - 1) * 100).toFixed(1)}%`);
  } finally {
    await client.close({ drainTimeoutMs: 1000 });
    await broker.stop();
  }
});
