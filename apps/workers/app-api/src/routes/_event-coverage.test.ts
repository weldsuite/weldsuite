/**
 * Static guard: every core-CRUD mutation handler must publish an entity
 * event via `publishEntityEvent`.
 *
 * After the hub pub/sub cutover (Phases 0–7), `publishEntityEvent` enqueues
 * once to `ENTITY_EVENTS`. Realtime, audit, workflows, analytics, and
 * WeldAgent all receive via hub subscriber queues (see
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
import { findMissingEntityEvents } from '@weldsuite/worker-kit/testing/sweeps';

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
  // (integrations, github-connections and github-repo-links moved to
  // connect-api with their exemptions.)
  'storage',
  'user-preferences',
  'team-members',
  // (mail-ai, mail-sync, mail-snooze, mail-threads and mail-weldmail moved to
  // mail-api with their exemptions.)
  // (workflow-builder and workflow-dashboard moved to connect-api with their
  // exemptions.)
  '_test-fixtures',
  // Settings / workspace read-only / singleton routes — no core-CRUD mutations.
  // (digest-settings and my-tasks moved to flow-api with their exemptions.)
  // dashboard: read-only home aggregates (only mutation is a JSONB flag flip, not an entity).
  'dashboard',
  // credits: master-DB billing ledger; not fanned out over the entity-event bus.
  'credits',
  // ai-models: read-only model catalog; no mutations.
  'ai-models',
  // access-requests — personal-topic notify()/publish() path, not a generic entity event.
  'access-requests',
  // search — read-only federated search; POST / fans out reads, performs no mutations.
  'search',
  // workspace-settings — singleton PUT / + PUT /name + POST /slug (no POST / create or /:id lifecycle); all publish workspace_settings.
  'workspace-settings',
  // auth-desktop — mints a Clerk sign-in token; no entity mutations.
  'auth-desktop',
  // cli-auth — device-code login mints a personal API key; credentials infra.
  'cli-auth',
  // chat-calls — WeldChat call records, stream over the ChatRoom DO, not the entity-event bus.
  'chat-calls',
  // (The Telnyx webhook receiver, webhooks-telnyx, moved to call-api.)
  // (external-webhooks and github-project-links moved to connect-api with their
  // exemptions.)
  // push-tokens — device push-notification token registration; not a business entity.
  'push-tokens',
  // feature-requests — master-global product-feedback table; not a tenant entity.
  'feature-requests',
  // roles — RBAC role definitions: permissions infra, no `role` entity type in the catalog.
  'roles',
]);

describe('app-api entity-event coverage', () => {
  const report = findMissingEntityEvents(ROUTES_DIR, EXEMPT_ROUTES);

  it('every core-CRUD mutation handler publishes an entity event', () => {
    expect(report.failures, `\n${report.failures.join('\n')}\n`).toEqual([]);
  });

  it('exemptions all reference real route directories', () => {
    expect(report.staleExemptions, `stale EXEMPT_ROUTES entries: ${report.staleExemptions.join(', ')}`).toEqual([]);
  });
});
