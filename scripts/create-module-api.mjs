#!/usr/bin/env node
/**
 * Scaffold a per-module API worker (apps/workers/<module>-api).
 *
 * Usage:
 *   pnpm create:module-api <module>        e.g. pnpm create:module-api pass
 *   pnpm create:module-api <module> --dry  print what would be written
 *
 * The module must exist in @weldsuite/api-modules (packages/core/api-modules),
 * which decides the worker name, dev port, service-binding name and the path
 * prefixes the worker owns. The scaffold gives you:
 *
 *   - wrangler.toml   dev/test/production, custom domains
 *                     (<module>-api[-test].weldsuite.org), the shared
 *                     WORKSPACE_CACHE KV, the ENTITY_EVENTS hub queue, the
 *                     REALTIME service and Flagship
 *   - src/index.ts    createModuleApi() + the /api/* auth guard, ready for the
 *                     module's routers
 *   - src/types.ts    Env / Variables extending the kit's
 *   - a smoke test, tsconfig, vitest config and package.json
 *   - an entry in scripts/secrets/manifest.ts with the kit's base secrets
 *
 * Moving the module's code in is the per-module recipe in
 * docs/plans/app-api-module-split.md; this only creates the empty worker.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Node 22 strips TypeScript types natively; the manifest is erasable-only TS.
const { API_MODULES } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/api-modules/src/index.ts')).href
);

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const id = args.find((a) => !a.startsWith('--'));

if (!id) {
  console.error('Usage: pnpm create:module-api <module> [--dry]');
  console.error(`Modules: ${API_MODULES.filter((m) => m.id !== 'core').map((m) => m.id).join(', ')}`);
  process.exit(1);
}

const mod = API_MODULES.find((m) => m.id === id);
if (!mod || mod.id === 'core') {
  console.error(`Unknown module "${id}". Add it to packages/core/api-modules/src/index.ts first.`);
  process.exit(1);
}

const workerDir = path.join(repoRoot, 'apps', 'workers', mod.worker);
const scriptName = `weldsuite-${mod.worker}`;

// Shared resource ids — the same ones app-api binds (apps/workers/app-api/wrangler.toml).
const SHARED = {
  dev: { kv: '748b8f38937f4807b3978cacb17e1880', queue: 'entity-events-dev', realtime: 'weldsuite-realtime-test' },
  test: {
    kv: '54dd4f453a5e4021a31695ada36cc708',
    queue: 'entity-events-test',
    realtime: 'weldsuite-realtime-test',
    flagship: 'd8c58a91-9e17-432b-b4e8-0f2c9959490e',
  },
  production: {
    kv: '99689831a815455ba7f836175e5e17c9',
    queue: 'entity-events',
    realtime: 'weldsuite-realtime-production',
    flagship: '895f413b-8b8d-4e6f-bb14-399721deb17e',
  },
};

const KIT_SHIMS = '../../../packages/core/worker-kit/shims';

const files = {
  'package.json': `${JSON.stringify(
    {
      name: mod.worker,
      license: 'AGPL-3.0-only',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        build: 'wrangler deploy --dry-run --outdir dist',
        deploy: 'wrangler deploy',
        'deploy:production': 'wrangler deploy --env production',
        'deploy:test': 'wrangler deploy --env test',
        dev: `wrangler dev --port ${mod.devPort}`,
        test: 'vitest run',
        'test:watch': 'vitest',
        'type-check': 'tsc --noEmit',
      },
      dependencies: {
        '@hono/zod-validator': '^0.4.0',
        '@weldsuite/api-modules': 'workspace:*',
        '@weldsuite/db': 'workspace:*',
        '@weldsuite/entity-events': 'workspace:*',
        '@weldsuite/permissions': 'workspace:*',
        '@weldsuite/worker-kit': 'workspace:*',
        'drizzle-orm': '^0.45.2',
        hono: '4.12.34',
        zod: '^3.25.76',
      },
      devDependencies: {
        '@cloudflare/workers-types': '^4.20250110.0',
        '@types/node': '^20',
        typescript: '^5.7',
        vitest: '^3.2.6',
        wrangler: '^4.95.0',
      },
    },
    null,
    2,
  )}\n`,

  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        lib: ['ESNext'],
        types: ['@cloudflare/workers-types'],
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src/**/*.ts'],
      exclude: ['node_modules'],
    },
    null,
    2,
  )}\n`,

  'vitest.config.ts': `import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
`,

  'wrangler.toml': `# WeldSuite ${mod.worker} worker — the ${mod.id} module's API.
#
# Split out of app-api (docs/plans/app-api-module-split.md). Serves the same
# /api/<object> paths app-api served for this module; only the host differs:
#   ${mod.worker}.weldsuite.org        production
#   ${mod.worker}-test.weldsuite.org   test
# The path prefixes it owns live in packages/core/api-modules.
#
# Secrets (scripts/secrets/manifest.ts → "${mod.worker}"):
#   DATABASE_URL_MASTER, NEON_API_KEY, DATABASE_ENCRYPTION_KEY,
#   CLERK_SECRET_KEY, CLERK_JWT_KEY

name = "${scriptName}"
main = "src/index.ts"
compatibility_date = "2024-12-30"
compatibility_flags = ["nodejs_compat"]

# @weldsuite/db's lib barrel optionally imports Next.js / React helpers that
# crash the Workers runtime; alias them to the kit's empty shims.
[alias]
"@clerk/nextjs/server" = "${KIT_SHIMS}/clerk-shim.ts"
"@clerk/nextjs" = "${KIT_SHIMS}/clerk-shim.ts"
"next/server" = "${KIT_SHIMS}/next-shim.ts"
"next/navigation" = "${KIT_SHIMS}/next-shim.ts"
"react" = "${KIT_SHIMS}/react-shim.ts"

[observability]
enabled = true
head_sampling_rate = 1

[vars]
ENVIRONMENT = "development"

[[kv_namespaces]]
binding = "WORKSPACE_CACHE"
id = "${SHARED.dev.kv}"

[[queues.producers]]
binding = "ENTITY_EVENTS"
queue = "${SHARED.dev.queue}"

# Remote binding so local dev reaches the deployed test realtime worker.
[[services]]
binding = "REALTIME"
service = "${SHARED.dev.realtime}"
remote = true

# ============ TEST ENVIRONMENT ============
[env.test]
logpush = true
name = "${scriptName}-test"
routes = [
  { pattern = "${mod.worker}-test.weldsuite.org", custom_domain = true }
]

[env.test.vars]
ENVIRONMENT = "test"

[[env.test.flagship]]
binding = "FLAGSHIP"
app_id = "${SHARED.test.flagship}"

[[env.test.kv_namespaces]]
binding = "WORKSPACE_CACHE"
id = "${SHARED.test.kv}"

[[env.test.queues.producers]]
binding = "ENTITY_EVENTS"
queue = "${SHARED.test.queue}"

[[env.test.services]]
binding = "REALTIME"
service = "${SHARED.test.realtime}"

[env.test.observability]
enabled = true
head_sampling_rate = 1

# ============ PRODUCTION ENVIRONMENT ============
[env.production]
logpush = true
name = "${scriptName}"
routes = [
  { pattern = "${mod.worker}.weldsuite.org", custom_domain = true }
]

[env.production.vars]
ENVIRONMENT = "production"

[[env.production.flagship]]
binding = "FLAGSHIP"
app_id = "${SHARED.production.flagship}"

[[env.production.kv_namespaces]]
binding = "WORKSPACE_CACHE"
id = "${SHARED.production.kv}"

[[env.production.queues.producers]]
binding = "ENTITY_EVENTS"
queue = "${SHARED.production.queue}"

[[env.production.services]]
binding = "REALTIME"
service = "${SHARED.production.realtime}"

[env.production.observability]
enabled = true
head_sampling_rate = 1
`,

  'src/types.ts': `import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * ${mod.worker} bindings: the kit's (auth, tenant DB, flags) plus only what
 * the ${mod.id} module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
}

export type Variables = KitVariables;
`,

  'src/index.ts': `/**
 * WeldSuite ${mod.worker} — the ${mod.id} module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: '${mod.worker}' });

// Public routes (webhooks, portals) mount here, above the auth guard.

app.use('/api/*', ...apiAuth());

// Authenticated routes: one app.route() per object prefix this module owns
// (packages/core/api-modules lists them).

export default {
  fetch: app.fetch,
};
`,

  'src/index.test.ts': `import { describe, expect, it } from 'vitest';
import worker from './index';

const env = { ENVIRONMENT: 'test' };

describe('${mod.worker}', () => {
  it('answers unknown paths with the JSON error envelope', async () => {
    const res = await worker.fetch(new Request('http://local/nope'), env as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '/nope not found' } });
  });

  it('requires a bearer token on /api/*', async () => {
    const res = await worker.fetch(new Request('http://local/api/anything'), env as never);
    expect(res.status).toBe(401);
  });
});
`,
};

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

if (await exists(workerDir)) {
  console.error(`${path.relative(repoRoot, workerDir)} already exists — refusing to overwrite.`);
  process.exit(1);
}

for (const [rel, content] of Object.entries(files)) {
  const target = path.join(workerDir, rel);
  if (dry) {
    console.log(`would write ${path.relative(repoRoot, target)} (${content.length} bytes)`);
    continue;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  console.log(`wrote ${path.relative(repoRoot, target)}`);
}

// Secrets manifest entry.
const secretsPath = path.join(repoRoot, 'scripts', 'secrets', 'manifest.ts');
// Normalise line endings: a Windows checkout (core.autocrlf) has CRLF here.
const secrets = (await fs.readFile(secretsPath, 'utf8')).replace(/\r\n/g, '\n');
if (!secrets.includes(`"${mod.worker}":`)) {
  const marker = '\n};\n\n// ── Helpers';
  const idx = secrets.indexOf(marker);
  if (idx < 0) {
    console.warn('Could not find the end of the manifest in scripts/secrets/manifest.ts — add the entry by hand.');
  } else {
    const entry = `

  // ${mod.worker}: the ${mod.id} module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "${mod.worker}": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],`;
    const next = secrets.slice(0, idx) + entry + secrets.slice(idx);
    if (dry) console.log(`would add "${mod.worker}" to scripts/secrets/manifest.ts`);
    else {
      await fs.writeFile(secretsPath, next);
      console.log(`added "${mod.worker}" to scripts/secrets/manifest.ts`);
    }
  }
}

console.log(`
Next steps (docs/plans/app-api-module-split.md, per-module recipe):
  1. pnpm install
  2. Move the ${mod.id} routes/services into ${path.relative(repoRoot, workerDir)}/src and mount them.
  3. Sync secrets:           DOPPLER_TOKEN=… pnpm secrets:sync test ${mod.worker}
  4. Deploy to test:         pnpm --filter ${mod.worker} deploy:test
  5. Let app-api forward:    add a ${mod.binding} service binding + "${mod.id}" to
                             API_FORWARD_MODULES in apps/workers/app-api/wrangler.toml
  6. Point clients at it:    add "${mod.id}" to VITE_API_MODULES / EXPO_PUBLIC_API_MODULES
`);
