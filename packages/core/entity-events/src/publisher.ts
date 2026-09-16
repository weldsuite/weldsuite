/**
 * publishEntityEvent — the orchestrator.
 *
 * Fans out a single entity mutation to:
 *   1. ENTITY_EVENTS hub queue (entity-events-worker) — audit / analytics /
 *      search-index / outbound webhooks fan-out happens in the hub
 *   2. REALTIME service binding → WorkspaceHub DO (@weldsuite/realtime)
 *   3. Cloudflare Workflow dispatch via env.EXECUTE_WORKFLOW (inline WeldConnect)
 *   4. WeldAgent (inline)
 *
 * Phase 0: stopped producing to the unused WORKFLOW_EVENTS queue.
 * Phase 1: hub registry + dual-write-ready ENTITY_EVENTS path.
 * Phase 2: producers bind ENTITY_EVENTS only for queue sinks; hub fans out to
 * audit-events / analytics-events / search-index.
 * Phase 3: outbound webhooks move off the publish path onto hub →
 * entity-webhooks* → integration-webhook-worker.
 *
 * Each sink is independently optional — a missing binding logs a warning
 * and the rest still fire. Wrapped in `executionCtx.waitUntil(...)` so the
 * HTTP response is never blocked.
 */

import type { Context } from 'hono';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type {
  EntityEventMessage,
  EntityAction,
  EventSource,
} from './types';
import type { EntityType } from './events';
import type { DataFor } from './events/data';
import { matchAndDispatchWorkflowTriggers, type WorkflowDispatchEnv } from './workflow-dispatch';
import { runRegisteredWeldAgentDispatch } from './agent-dispatch';
import type { TenantDb } from './internal-types';

// ---------------------------------------------------------------------------
// Env shape required by the publisher (structural — workers' own Env types
// extend this naturally)
// ---------------------------------------------------------------------------

export interface EntityEventPublisherEnv extends WorkflowDispatchEnv {
  /**
   * Hub queue consumed by `entity-events-worker`, which fans out to
   * audit / analytics / search-index / outbound webhooks subscriber queues.
   */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  REALTIME?: Fetcher;
}

export interface EntityEventPublisherVariables {
  workspaceId: string;
  userId: string;
  tenantDb: TenantDb;
}

// ---------------------------------------------------------------------------
// ID generation (evt_…)
// ---------------------------------------------------------------------------

function generateEventId(): string {
  // 8-byte hex random suffix — sufficient for fire-and-forget event ids.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `evt_${hex}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PublishEntityEventParams<
  E extends EntityType = EntityType,
  B extends EntityEventPublisherEnv = EntityEventPublisherEnv,
  V extends EntityEventPublisherVariables = EntityEventPublisherVariables,
> {
  c: Context<{
    Bindings: B;
    Variables: V;
  }>;
  /** Catalog-typed entity name — typos fail at compile time. */
  entityType: E;
  /** Catalog-typed action for the entity — typos fail at compile time. */
  action: EntityAction;
  entityId: string;
  /**
   * Entity payload. For entities backed by a Drizzle table this is the
   * row type (`typeof table.$inferSelect`); for unmapped entities it
   * falls back to `Record<string, unknown>`. See `events/data.ts`.
   */
  data: DataFor<E>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  /** When set, only these users receive the realtime event. */
  accessUserIds?: string[];
  /** Defaults to `'api'`. */
  source?: EventSource;
}

// ---------------------------------------------------------------------------
// Shared fan-out — used by both the Hono-context and context-free publishers
// so the two can never drift.
// ---------------------------------------------------------------------------

interface FanOutParams {
  env: EntityEventPublisherEnv;
  db: TenantDb;
  workspaceId: string;
  userId: string;
  entityType: EntityType;
  action: EntityAction;
  entityId: string;
  /** Opaque payload at the wire level. */
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  accessUserIds?: string[];
}

/**
 * Build the wire message and return a promise per active sink. Callers decide
 * whether to `waitUntil` them (request context) or `await` them (workflow /
 * raw context). Never throws — each sink swallows its own errors.
 */
function fanOutEntityEvent(params: FanOutParams, source: EventSource): Promise<unknown>[] {
  const { env, db, workspaceId, userId, entityType, action, entityId, data, changes, accessUserIds } = params;

  const message: EntityEventMessage = {
    id: generateEventId(),
    eventType: `${entityType}:${action}` as `${string}:${string}`,
    entityType,
    entityId,
    action,
    data,
    ...(changes ? { changes } : {}),
    metadata: {
      workspaceId,
      userId,
      timestamp: new Date().toISOString(),
      source,
    },
  };

  const tasks: Promise<unknown>[] = [];

  // 1. Hub queue — entity-events-worker fans out to audit / analytics / search / webhooks
  if (env.ENTITY_EVENTS) {
    tasks.push(
      env.ENTITY_EVENTS.send(message)
        .then(() => console.log(`[EntityEvents] Published hub event ${message.eventType} for ${entityId}`))
        .catch((err: unknown) => console.error('[EntityEvents] Failed to publish hub event:', err)),
    );
  }

  // 2. Cloudflare DO realtime (stays on publish path until Phase 6)
  if (workspaceId && env.REALTIME) {
    tasks.push(
      (async () => {
        try {
          const realtime = new RealtimePublisher(env.REALTIME!);
          const realtimeData = accessUserIds
            ? { ...(data as object), _access: { userIds: accessUserIds } }
            : data;
          await realtime.publish(workspaceId, entityType, action, realtimeData, userId);
        } catch (err) {
          console.error('[EntityEvents] Failed to publish realtime event:', err);
        }
      })(),
    );
  }

  if (!env.ENTITY_EVENTS && !env.REALTIME) {
    console.warn('[EntityEvents] No queue or realtime bindings available — skipping publish');
  }

  // 3. Inline workflow trigger matching (CF Workflows binding) — Phase 4 will move to hub
  if (workspaceId && env.EXECUTE_WORKFLOW) {
    tasks.push(
      matchAndDispatchWorkflowTriggers({
        env,
        db,
        workspaceId,
        userId,
        entityType,
        entityId,
        action,
        data,
        changes: changes ?? undefined,
      }).catch((err) => console.error('[EntityEvents] Failed to match workflow triggers:', err)),
    );
  }

  // 4. Workspace AI agents (optional runner registered by app-api) — Phase 5 will move to hub
  if (workspaceId) {
    tasks.push(
      runRegisteredWeldAgentDispatch({
        workspaceId,
        userId,
        entityType,
        action,
        entityId,
        data: data as Record<string, unknown>,
        db,
        env,
      }).catch((err: unknown) =>
        console.error('[EntityEvents] Failed to dispatch weldagent event:', err),
      ),
    );
  }

  return tasks;
}

/**
 * Fire-and-forget entity event publisher. Returns immediately; all
 * downstream work runs inside `executionCtx.waitUntil(...)`.
 */
export function publishEntityEvent<
  E extends EntityType,
  B extends EntityEventPublisherEnv = EntityEventPublisherEnv,
  V extends EntityEventPublisherVariables = EntityEventPublisherVariables,
>(params: PublishEntityEventParams<E, B, V>): void {
  const { c, entityType, entityId, action, data, changes, accessUserIds, source = 'api' } = params;

  const tasks = fanOutEntityEvent(
    {
      env: c.env,
      db: c.get('tenantDb'),
      workspaceId: c.get('workspaceId') ?? '',
      userId: c.get('userId'),
      entityType,
      entityId,
      action,
      // The strongly-typed `DataFor<E>` payload is structurally compatible at
      // the wire level; cast once here.
      data: data as unknown as Record<string, unknown>,
      changes,
      accessUserIds,
    },
    source,
  );

  for (const task of tasks) {
    c.executionCtx.waitUntil(task);
  }
}

// ---------------------------------------------------------------------------
// Context-free publisher — for workers without a Hono Context (Workflows,
// queue consumers, the integration webhook worker). Awaits all sinks.
// ---------------------------------------------------------------------------

export interface PublishEntityEventRawParams {
  env: EntityEventPublisherEnv;
  db: TenantDb;
  workspaceId: string;
  userId: string;
  entityType: EntityType;
  action: EntityAction;
  entityId: string;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  accessUserIds?: string[];
  /** Defaults to `'system'` since these callers are usually background jobs. */
  source?: EventSource;
}

/**
 * Context-free entity event publisher. Same fan-out as `publishEntityEvent`
 * but takes plain `{ env, db }` instead of a Hono `Context`, and awaits every
 * sink (safe to call inside a Workflow `step.do` or a webhook handler).
 */
export async function publishEntityEventRaw(params: PublishEntityEventRawParams): Promise<void> {
  const { source = 'system', ...rest } = params;
  const tasks = fanOutEntityEvent(rest, source);
  await Promise.allSettled(tasks);
}
