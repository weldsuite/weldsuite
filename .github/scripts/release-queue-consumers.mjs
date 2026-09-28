#!/usr/bin/env node
/**
 * Before a module API worker deploys, release the queues it consumes from
 * app-api (docs/plans/app-api-module-split.md).
 *
 *   node .github/scripts/release-queue-consumers.mjs <worker> <test|production> [--dry]
 *
 * A Cloudflare queue has exactly one consumer, and module workers deploy
 * BEFORE app-api (deploy.yml `module-workers` job). When a queue consumer moves
 * out of app-api (e.g. entity-agents → agent-api), the still-deployed app-api
 * holds the queue and the module worker's deploy fails with
 * "Queue … already has a consumer [code: 11004]". The new app-api build no
 * longer declares the consumer, so it is safe to detach the old one first;
 * messages wait in the queue for the few seconds until the module worker's
 * deploy attaches itself.
 *
 * Only app-api's consumer is removed, and only when it is the current one: a
 * queue consumed by any other worker is left alone (and the deploy then fails
 * loudly, as it should). Runs inside apps/workers/<worker> with wrangler's
 * CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the environment.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [worker, env] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry');
if (!worker || !['test', 'production'].includes(env ?? '')) {
  console.error('Usage: release-queue-consumers.mjs <worker> <test|production> [--dry]');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerDir = path.join(repoRoot, 'apps/workers', worker);
const toml = readFileSync(path.join(workerDir, 'wrangler.toml'), 'utf8').replace(/\r\n/g, '\n');

// Queues this worker consumes in the target env: `queue = "…"` inside
// `[[env.<env>.queues.consumers]]` blocks.
const header = `[[env.${env}.queues.consumers]]`;
const queues = [];
for (const block of toml.split(/\n(?=\[)/)) {
  if (!block.startsWith(header)) continue;
  const m = /^queue\s*=\s*"([^"]+)"/m.exec(block);
  if (m) queues.push(m[1]);
}
if (queues.length === 0) {
  console.log(`${worker}: consumes no queues in ${env}`);
  process.exit(0);
}

const appApiScript = env === 'test' ? 'weldsuite-app-api-test' : 'weldsuite-app-api';

function wrangler(args) {
  return execFileSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: workerDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

for (const queue of queues) {
  const info = wrangler(['queues', 'info', queue]);
  // `wrangler queues info` prints "Number of Consumers: N" and "Consumers: worker:<script>, …".
  const consumers = /^Consumers:\s*(.*)$/m.exec(info)?.[1] ?? '';
  if (!consumers.split(/[,\s]+/).includes(`worker:${appApiScript}`)) {
    console.log(`${queue}: not consumed by ${appApiScript} (${consumers.trim() || 'no consumer'}), nothing to release`);
    continue;
  }
  if (dryRun) {
    console.log(`${queue}: would release from ${appApiScript} (--dry)`);
    continue;
  }
  wrangler(['queues', 'consumer', 'remove', queue, appApiScript]);
  console.log(`${queue}: released from ${appApiScript}; ${worker} takes it over on deploy`);
}
