/**
 * Cross-route safety sweeps shared by every API worker.
 *
 * These return results instead of asserting, so each worker's own test file
 * owns its `describe`/`expect` (no reliance on sharing one Vitest instance
 * with this package). Typical use in `src/routes/_sweeps.test.ts`:
 *
 *   describe.each(AUTH_CASES)('$mount · auth gates', (c) => {
 *     it('refuses without the permission', async () => {
 *       for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
 *     });
 *   });
 *
 * - `authGateStatuses`: every standard CRUD endpoint answers 403 without its
 *   `<prefix>:<action>` permission.
 * - `listEndpointResult`: GET / answers 200 with the list envelope against an
 *   empty tenant (pglite).
 * - `findMissingEntityEvents`: static check that every core-CRUD mutation
 *   handler publishes an entity event (`publishEntityEvent`).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { Database, KitEnv, KitVariables } from '../env';
import { createTestApp, permissions } from './harness';

// ── Auth gates ──────────────────────────────────────────────────────────────

export interface AuthGateCase<E extends KitEnv = KitEnv, V extends KitVariables = KitVariables> {
  /** Mount path, e.g. `/api/orders`. */
  mount: string;
  router: Hono<{ Bindings: E; Variables: V }>;
  /** Permission prefix: `orders` → `orders:read|create|update|delete`. */
  prefix: string;
  skipGet?: boolean;
  skipPost?: boolean;
  skipPatch?: boolean;
  skipDelete?: boolean;
}

export interface GateResult {
  label: string;
  status: number;
}

/** Status of each standard CRUD call made WITHOUT the gating permission. */
export async function authGateStatuses<E extends KitEnv, V extends KitVariables>(
  c: AuthGateCase<E, V>,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const json = { 'Content-Type': 'application/json' };
  const readOnly = { context: { permissions: permissions(`${c.prefix}:read`) } };

  if (!c.skipGet) {
    const { request } = createTestApp(c.mount, c.router, { context: { permissions: permissions() } });
    results.push({ label: `GET ${c.mount} without ${c.prefix}:read`, status: (await request(c.mount)).status });
  }
  if (!c.skipPost) {
    const { request } = createTestApp(c.mount, c.router, readOnly);
    const res = await request(c.mount, { method: 'POST', headers: json, body: '{}' });
    results.push({ label: `POST ${c.mount} without ${c.prefix}:create`, status: res.status });
  }
  if (!c.skipPatch) {
    const { request } = createTestApp(c.mount, c.router, readOnly);
    const res = await request(`${c.mount}/some_id`, { method: 'PATCH', headers: json, body: '{}' });
    results.push({ label: `PATCH ${c.mount}/:id without ${c.prefix}:update`, status: res.status });
  }
  if (!c.skipDelete) {
    const { request } = createTestApp(c.mount, c.router, readOnly);
    const res = await request(`${c.mount}/some_id`, { method: 'DELETE' });
    results.push({ label: `DELETE ${c.mount}/:id without ${c.prefix}:delete`, status: res.status });
  }
  return results;
}

// ── List endpoints ─────────────────────────────────────────────────────────

export interface ListSweepCase<E extends KitEnv = KitEnv, V extends KitVariables = KitVariables> {
  mount: string;
  router: Hono<{ Bindings: E; Variables: V }>;
  /** Permission granted for the GET, e.g. `companies:read`. */
  permission: string;
}

export interface ListSweepResult {
  status: number;
  /** True when `data` is an array and any `pagination` has the standard shape. */
  envelopeOk: boolean;
}

/** GET <mount> against `db` (an empty pglite tenant) with only the read permission. */
export async function listEndpointResult<E extends KitEnv, V extends KitVariables>(
  c: ListSweepCase<E, V>,
  db: Database,
): Promise<ListSweepResult> {
  const { request } = createTestApp(c.mount, c.router, {
    context: { permissions: permissions(c.permission), tenantDb: db },
  });
  const res = await request(c.mount);
  if (res.status !== 200) return { status: res.status, envelopeOk: false };
  const body = (await res.json()) as {
    data?: unknown;
    pagination?: { totalCount?: unknown; hasMore?: unknown };
  };
  const envelopeOk =
    Array.isArray(body.data) &&
    (!body.pagination ||
      (typeof body.pagination.totalCount === 'number' && typeof body.pagination.hasMore === 'boolean'));
  return { status: res.status, envelopeOk };
}

// ── Entity-event coverage ──────────────────────────────────────────────────
//
// Scope is deliberately the *core* CRUD surface only:
//   create: app.post('/', …)   update: app.patch|put('/:id', …)   delete: app.delete('/:id', …)
// Sub-action endpoints (`/:id/approve`, `/:id/members`) are not checked.

interface Handler {
  method: string;
  path: string;
  /** Source text from this handler declaration up to the next `app.x(`. */
  body: string;
}

/** Split a route file into per-`app.method(...)` handler blocks. */
function parseHandlers(source: string): Handler[] {
  const decl = /\bapp\.(get|post|put|patch|delete|on|route)\(\s*['"]([^'"]*)['"]/g;
  const boundary = /\bapp\.\w+\(/g;
  const handlers: Handler[] = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(source)) !== null) {
    const start = m.index;
    boundary.lastIndex = start + 1;
    const next = boundary.exec(source);
    const end = next ? next.index : source.length;
    handlers.push({ method: m[1]!, path: m[2]!, body: source.slice(start, end) });
  }
  return handlers;
}

/**
 * Names of top-level `function`/`const` handlers (or helpers) in a file that
 * publish — directly or transitively (`updateRoute` → `patchHandler` →
 * `publishEntityEvent`). A registration referencing such a symbol publishes.
 */
function collectPublishingHelpers(source: string): Set<string> {
  const blocks = collectTopLevelBlocks(source);

  const publishing = new Set<string>();
  for (const [name, block] of blocks) {
    if (block.includes('publishEntityEvent')) publishing.add(name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, block] of blocks) {
      if (publishing.has(name) || !referencesAny(block, publishing)) continue;
      publishing.add(name);
      changed = true;
    }
  }
  return publishing;
}

/** Top-level `function`/`const` declarations in a file, keyed by name. */
function collectTopLevelBlocks(source: string): Map<string, string> {
  // Anchor declarations to column 0 (top-level only) so that *indented*
  // inner declarations inside a helper body don't prematurely end its block.
  const declRe = /(?:^|\n)(?:export )?(?:async )?(?:function (\w+)|const (\w+)\s*=)/g;
  const boundaryRe = /\bapp\.\w+\(|(?:^|\n)(?:export )?(?:async )?(?:function \w+|const \w+\s*=)/g;

  const blocks = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    const name = (m[1] ?? m[2])!;
    boundaryRe.lastIndex = m.index + 1;
    const next = boundaryRe.exec(source);
    const end = next ? next.index : source.length;
    blocks.set(name, source.slice(m.index, end));
  }
  return blocks;
}

/** Whether `text` mentions any of `names` as a whole word. */
function referencesAny(text: string, names: Iterable<string>): boolean {
  for (const name of names) {
    if (new RegExp(String.raw`\b${name}\b`).test(text)) return true;
  }
  return false;
}

function handlerPublishes(h: Handler, helpers: Set<string>): boolean {
  return h.body.includes('publishEntityEvent') || referencesAny(h.body, helpers);
}

function isCoreCrud(h: Handler): boolean {
  if (h.method === 'post' && h.path === '/') return true;
  if ((h.method === 'patch' || h.method === 'put') && h.path === '/:id') return true;
  if (h.method === 'delete' && h.path === '/:id') return true;
  return false;
}

/** Route directories under `routesDir` that have an `index.ts`. */
export function routeDirs(routesDir: string): string[] {
  return readdirSync(routesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(routesDir, name, 'index.ts')))
    .sort((a, b) => a.localeCompare(b));
}

export interface EventCoverageReport {
  /** `dir: app.post('/') has no publishEntityEvent` lines. */
  failures: string[];
  /** Exemptions that name a route directory that no longer exists here. */
  staleExemptions: string[];
}

export function findMissingEntityEvents(routesDir: string, exempt: ReadonlySet<string>): EventCoverageReport {
  const dirs = routeDirs(routesDir);
  const failures: string[] = [];
  for (const dir of dirs) {
    if (exempt.has(dir)) continue;
    const source = readFileSync(join(routesDir, dir, 'index.ts'), 'utf8');
    const helpers = collectPublishingHelpers(source);
    for (const h of parseHandlers(source)) {
      if (!isCoreCrud(h)) continue;
      if (!handlerPublishes(h, helpers)) {
        failures.push(`${dir}: app.${h.method}('${h.path}') has no publishEntityEvent`);
      }
    }
  }
  const present = new Set(dirs);
  return { failures, staleExemptions: [...exempt].filter((d) => !present.has(d)) };
}
