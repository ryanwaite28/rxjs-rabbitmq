// Packs the library, installs the tarball into a throwaway ESM project ("type": "module",
// NodeNext, verbatimModuleSyntax, exactOptionalPropertyTypes, noUncheckedIndexedAccess), then
// type-checks (TypeScript 6) and runs it. Usage: node scripts/smoke-packed.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const dir = mkdtempSync(path.join(process.env.SMOKE_TMPDIR || tmpdir(), 'rxjs-rabbitmq-smoke-'));

try {
  const tarball = run('npm', ['pack', '--silent', '--pack-destination', dir], root).trim().split('\n').pop();
  const { peerDependencies } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', path.join(dir, tarball), `amqplib@${peerDependencies.amqplib}`, `rxjs@${peerDependencies.rxjs}`, 'typescript@~6.0.3', '@types/node@^24'], dir);

  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'],
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true,
    },
    files: ['index.ts'],
  }));
  const source = `
import rxjsRabbitmq, { RabbitMQClient, PublishNackedError } from 'rxjs-rabbitmq';
import type { ClientState, RmqEventMessage } from 'rxjs-rabbitmq';

const client = new RabbitMQClient<'app.q', 'app.ex', \`app.\${string}\`>({
  connection_url: 'amqp://localhost', stopAutoInit: true, topology: 'verify', confirm: true,
  logger: { info() {}, warn() {}, error() {} },
});
client.onQueue('app.q').handleAll(async (event: RmqEventMessage<unknown, 'app.q', 'app.ex', \`app.\${string}\`>) => {
  await event.republish({ exchange: 'app.ex', routingKey: 'app.q.retry.1s', headers: { 'x-retry-count': 1 } });
});
const state: ClientState = client.state;
if (rxjsRabbitmq.PublishNackedError !== PublishNackedError) throw new Error('default/named mismatch');
await client.close();
console.log('smoke ok', state, typeof RabbitMQClient);
`;
  writeFileSync(path.join(dir, 'index.ts'), source);
  writeFileSync(path.join(dir, 'index.js'), source.replace(/: RmqEventMessage<[^)]*>\)/, ')').replace(/^import type .*$/m, '').replace(/<'app\.q'[^(]*\(/, '(').replace(/const state: ClientState/, 'const state'));
  run(process.execPath, [path.join(dir, 'node_modules/typescript/bin/tsc'), '-p', dir], dir);
  console.log('type-check (TypeScript 6, NodeNext ESM, strict flags): ok');
  process.stdout.write(run(process.execPath, [path.join(dir, 'index.js')], dir));
  const require = run(process.execPath, ['-e', "const m = require('rxjs-rabbitmq'); console.log('require ok', typeof m.RabbitMQClient)"], dir);
  process.stdout.write(require);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
