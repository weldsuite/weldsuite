/**
 * Static guard: every core-CRUD mutation handler must publish an entity
 * event via `publishEntityEvent`.
 *
 * The realtime WebSocket fan-out, audit log, workflow engine, analytics,
 * and AI-agent dispatch all hang off `publishEntityEvent` (see
 * packages/core/entity-events/src/publisher.ts). A create/update/delete that
 * forgets to call it is invisible to all of those systems — this test
 * stops that regressing.
 *
 * Scope is deliberately the *core* CRUD surface only:
 *   - create:  app.post('/', ...)
 *   - update:  app.patch('/:id', ...) or app.put('/:id', ...)
 *   - delete:  app.delete('/:id', ...)
 * Sub-action endpoints (e.g. `/:id/approve`, `/:id/members`) are not
 * checked here — they publish a custom action where it makes sense, but
 * forcing every one of them to emit would be noise.
 *
 * EXEMPT_ROUTES lists route directories intentionally excluded:
 *   - WeldChat routes stream over their own ChatRoom Durable Object, not
 *     the entity-event bus.
 *   - Notification routes use the personal-topic `notify()` path, which
 *     is not a generic entity event.
 *   - Infra / non-entity-object routes (api keys, audit logs, OAuth
 *     connections, raw storage, per-user preferences, mail sync jobs,
 *     workflow builder/dashboard aggregates) have nothing meaningful to
 *     fan out.
 * Anything added here must have a one-line reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'channels',
  'channel-members',
  'chat-messages',
  'chat-bookmarks',
  'chat-drafts',
  'chat-sections',
  'chat-activity', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-directories', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-dm', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-entity-channels', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-search', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-status', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  // Notifications — personal-topic notify() path, not a generic entity event.
  'notifications',
  'notification-preferences',
  // Infra / non-entity-object routes.
  'api-keys',
  // workspace-api-keys — credentials, like api-keys above: infra, not a
  // business entity, and the events catalog has no `api_key` entity type.
  'workspace-api-keys',
  'audit-logs',
  'integrations',
  // helpdesk-integrations — Discord/Slack channel connections on the same
  // integrationConnections table as `integrations` above: infra, not a
  // business entity, and the events catalog has no integration-connection
  // entity type (only `workflow_integration`, an unrelated object).
  'helpdesk-integrations',
  'github-connections',
  'github-repo-links',
  'storage',
  'user-preferences',
  'team-members',
  'mail-ai',
  'mail-sync',
  'mail-snooze',
  'mail-threads',
  'mail-weldmail',
  'workflow-builder',
  'workflow-dashboard',
  'enrichments',
  '_test-fixtures',
  // Accounting read-only / singleton routes — no core-CRUD mutations.
  // accounting-settings: singleton PUT / (not PUT /:id); no post('/') create.
  // accounting-reports, accounting-dashboard: read-only aggregates only.
  'accounting-settings',
  'accounting-reports',
  'accounting-dashboard',
  // Parcel helper / singleton / read-only routes — no standard /:id CRUD surface.
  // parcel-settings: singleton GET / + PUT / (no resource /:id lifecycle).
  // parcel-rates: action-only (POST /calculate, POST /select); no resource lifecycle.
  // parcel-analytics: read-only aggregates only; no mutations.
  'parcel-settings',
  'parcel-rates',
  'parcel-analytics',
  // Social helper / singleton / read-only routes — no standard /:id CRUD surface.
  // social-analytics: read-only aggregates (overview, stats, search); no mutations.
  // social-settings: singleton GET / + PUT / (no resource /:id lifecycle).
  'social-analytics',
  'social-settings',
  // Settings / workspace read-only / singleton routes — no core-CRUD mutations.
  // digest-settings: singleton GET / + PUT / (PUT / still publishes digest_settings).
  'digest-settings',
  // dashboard: read-only home aggregates (only mutation is a JSONB flag flip, not an entity).
  'dashboard',
  // credits: master-DB billing ledger; not fanned out over the entity-event bus.
  'credits',
  // ai-models: read-only model catalog; no mutations.
  'ai-models',
  // my-tasks: read-only assigned-task list; no mutations.
  'my-tasks',
  // access-requests — personal-topic notify()/publish() path, not a generic entity event.
  'access-requests',
  // search — read-only federated search; POST / fans out reads, performs no mutations.
  'search',
  // workspace-settings — singleton PUT / + PUT /name + POST /slug (no POST / create or /:id lifecycle); all publish workspace_settings.
  'workspace-settings',
  // auth-desktop — mints a Clerk sign-in token; no entity mutations.
  'auth-desktop',
  // wms-activity — read-only append-only audit log; no mutations, no entity events.
  'wms-activity',
]);

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
    handlers.push({ method: m[1], path: m[2], body: source.slice(start, end) });
  }
  return handlers;
}

/**
 * Names of top-level `function`/`const` handlers (or helpers) in a file
 * that publish — directly or transitively. Some routes share a single
 * update handler across put + patch (`app.put('/:id', …, updateRoute)`),
 * fan out via a helper (`publishBothSides(...)`), or chain helpers
 * (`updateRoute` → `patchHandler` → `publishEntityEvent`). A registration
 * that references such a symbol publishes through it, not inline.
 */
function collectPublishingHelpers(source: string): Set<string> {
  // Anchor declarations to column 0 (top-level only) so that *indented*
  // inner declarations inside a helper body don't prematurely end its block.
  const declRe =
    /(?:^|\n)(?:export )?(?:async )?(?:function (\w+)|const (\w+)\s*=)/g;
  const boundaryRe =
    /\bapp\.\w+\(|(?:^|\n)(?:export )?(?:async )?(?:function \w+|const \w+\s*=)/g;

  const blocks = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    const name = m[1] ?? m[2];
    boundaryRe.lastIndex = m.index + 1;
    const next = boundaryRe.exec(source);
    const end = next ? next.index : source.length;
    blocks.set(name, source.slice(m.index, end));
  }

  // Seed with symbols that publish inline, then close transitively over
  // symbols that reference an already-publishing symbol.
  const publishing = new Set<string>();
  for (const [name, block] of blocks) {
    if (block.includes('publishEntityEvent')) publishing.add(name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, block] of blocks) {
      if (publishing.has(name)) continue;
      for (const pub of publishing) {
        if (new RegExp(`\\b${pub}\\b`).test(block)) {
          publishing.add(name);
          changed = true;
          break;
        }
      }
    }
  }
  return publishing;
}

/** Does this handler publish — inline, or through a publishing helper? */
function handlerPublishes(h: Handler, helpers: Set<string>): boolean {
  if (h.body.includes('publishEntityEvent')) return true;
  for (const name of helpers) {
    if (new RegExp(`\\b${name}\\b`).test(h.body)) return true;
  }
  return false;
}

/** Is this handler part of the core CRUD surface we require events on? */
function isCoreCrud(h: Handler): boolean {
  if (h.method === 'post' && h.path === '/') return true;
  if ((h.method === 'patch' || h.method === 'put') && h.path === '/:id') return true;
  if (h.method === 'delete' && h.path === '/:id') return true;
  return false;
}

function routeDirs(): string[] {
  return readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(ROUTES_DIR, name, 'index.ts')))
    .sort();
}

describe('app-api entity-event coverage', () => {
  it('every core-CRUD mutation handler publishes an entity event', () => {
    const failures: string[] = [];

    for (const dir of routeDirs()) {
      if (EXEMPT_ROUTES.has(dir)) continue;
      const source = readFileSync(join(ROUTES_DIR, dir, 'index.ts'), 'utf8');
      const helpers = collectPublishingHelpers(source);
      for (const h of parseHandlers(source)) {
        if (!isCoreCrud(h)) continue;
        if (!handlerPublishes(h, helpers)) {
          failures.push(`${dir}: app.${h.method}('${h.path}') has no publishEntityEvent`);
        }
      }
    }

    expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
  });

  it('exemptions all reference real route directories', () => {
    const dirs = new Set(routeDirs());
    const stale = [...EXEMPT_ROUTES].filter((r) => !dirs.has(r));
    expect(stale, `stale EXEMPT_ROUTES entries: ${stale.join(', ')}`).toEqual([]);
  });
});
