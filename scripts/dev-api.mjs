#!/usr/bin/env node
/**
 * Run app-api and every per-module API worker in ONE `wrangler dev` session.
 *
 *   pnpm dev:api
 *
 * app-api gets the HTTP port (8789); the module workers
 * (apps/workers/<module>-api, see docs/plans/app-api-module-split.md) are
 * reachable through their service bindings (`<MODULE>_API` in app-api's dev
 * config), and app-api forwards their paths (API_FORWARD_MODULES is set
 * here). The platform keeps talking to http://localhost:8789 only, so leave
 * VITE_API_MODULES empty.
 *
 * To work on one module on its own port instead:
 *   pnpm --filter <module>-api dev          # e.g. pass-api on 8820
 *   VITE_API_MODULES=<module>               # in apps/web/platform/.env.local
 *
 * Extra arguments are passed through to wrangler.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { API_MODULES } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/api-modules/src/index.ts')).href
);

const workersDir = path.join(repoRoot, 'apps', 'workers');
const present = API_MODULES.filter((m) =>
  existsSync(path.join(workersDir, m.worker, 'wrangler.toml')),
);
// app-api (core) first: the first config gets the HTTP port.
present.sort((a, b) => (a.id === 'core' ? -1 : b.id === 'core' ? 1 : 0));

const configs = present.flatMap((m) => ['-c', path.join(workersDir, m.worker, 'wrangler.toml')]);
const forwarded = present.filter((m) => m.id !== 'core').map((m) => m.id);

console.log(`API workers: ${present.map((m) => m.worker).join(', ')}`);
if (forwarded.length > 0) {
  console.log(`app-api forwards: ${forwarded.join(', ')}`);
}

const forwardVar = forwarded.length > 0 ? ['--var', `API_FORWARD_MODULES:${forwarded.join(',')}`] : [];

// `pnpm exec` finds wrangler wherever pnpm hoisted it.
const child = spawn(
  'pnpm',
  ['exec', 'wrangler', 'dev', ...configs, '--port', '8789', ...forwardVar, ...process.argv.slice(2)],
  { cwd: path.join(workersDir, 'app-api'), stdio: 'inherit', shell: process.platform === 'win32' },
);
child.on('exit', (code) => process.exit(code ?? 0));
