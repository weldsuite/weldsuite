/**
 * publishEntityEvent — hub-only publisher (Phase 7).
 *
 * Builds one `EntityEventMessage` and enqueues it on `ENTITY_EVENTS`.
 * All fan-out (audit, analytics, search-index, webhooks, WeldConnect,
 * WeldAgent, realtime) happens in `entity-events-worker` via the subscriber
 * registry — producers never N-way send.
 *
 * Wrapped in `executionCtx.waitUntil(...)` so the HTTP response is never blocked.
 */

import type { Context } from 'hono';
import type {
  EntityEventMessage,
  EntityAction,
  EventSource,
} from './types';
import type { EntityType } from './events';
import type { DataFor } from './events/data';
import type { TenantDb } from './internal-types';

// ---------------------------------------------------------------------------
// Env shape required by the publisher (structural — workers' own Env types
// extend this naturally)
// ---------------------------------------------------------------------------

/**
 * After Phase 7, producers only need the hub queue for entity-event fan-out.
 * Unrelated bindings (`REALTIME` for chat, `EXECUTE_WORKFLOW` for manual runs,
 * etc.) stay on worker `Env` types — they are not part of this interface.
 */
export interface EntityEventPublisherEnv {
  /**
   * Hub queue consumed by `entity-events-worker`, which fans out to
   * audit / analytics / search-index / webhooks / WeldConnect / WeldAgent /
   * realtime subscriber queues.
   */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
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
  /**
   * When set, only these users receive the realtime event (carried on the
   * hub message as `accessUserIds`; the realtime bridge stitches `_access`).
   */
  accessUserIds?: string[];
  /** Defaults to `'api'`. */
  source?: EventSource;
}

// ---------------------------------------------------------------------------
// Shared hub enqueue — used by both the Hono-context and context-free publishers
// so the two can never drift.
// ---------------------------------------------------------------------------

interface HubEnqueueParams {
  env: EntityEventPublisherEnv;
  workspaceId: string;
  userId: string;
  entityType: EntityType;
  action: EntityAction;
  entityId: string;
  /** Opaque payload at the wire level. */
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  accessUserIds?: string[];
  workflowDepth?: number;
}

/**
 * Build the wire message and enqueue to the hub. Returns a promise so callers
 * can `waitUntil` (request context) or `await` (workflow / raw context).
 * Never throws — swallows send errors after logging.
 */
function enqueueHubEntityEvent(params: HubEnqueueParams, source: EventSource): Promise<unknown>[] {
  const { env, workspaceId, userId, entityType, action, entityId, data, changes, accessUserIds, workflowDepth } =
    params;

  const message: EntityEventMessage = {
    id: generateEventId(),
    eventType: `${entityType}:${action}` as `${string}:${string}`,
    entityType,
    entityId,
    action,
    data,
    ...(changes ? { changes } : {}),
    ...(accessUserIds?.length ? { accessUserIds } : {}),
    metadata: {
      workspaceId,
      userId,
      timestamp: new Date().toISOString(),
      source,
      ...(workflowDepth !== undefined ? { workflowDepth } : {}),
    },
  };

  if (!env.ENTITY_EVENTS) {
    console.warn('[EntityEvents] No ENTITY_EVENTS binding available — skipping publish');
    return [];
  }

  return [
    env.ENTITY_EVENTS.send(message)
      .then(() =>
        console.log(`[EntityEvents] Published hub event ${message.eventType} for ${entityId}`),
      )
      .catch((err: unknown) => console.error('[EntityEvents] Failed to publish hub event:', err)),
  ];
}

/**
 * Fire-and-forget entity event publisher. Returns immediately; hub enqueue
 * runs inside `executionCtx.waitUntil(...)`.
 */
export function publishEntityEvent<
  E extends EntityType,
  B extends EntityEventPublisherEnv = EntityEventPublisherEnv,
  V extends EntityEventPublisherVariables = EntityEventPublisherVariables,
>(params: PublishEntityEventParams<E, B, V>): void {
  const { c, entityType, entityId, action, data, changes, accessUserIds, source = 'api' } = params;

  const tasks = enqueueHubEntityEvent(
    {
      env: c.env,
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
// queue consumers, the integration webhook worker). Awaits the hub send.
// ---------------------------------------------------------------------------

export interface PublishEntityEventRawParams {
  env: EntityEventPublisherEnv;
  /**
   * Unused after Phase 7 (hub collapse). Kept for call-site compatibility —
   * tenant DB is resolved in subscriber consumers, not on the publish path.
   */
  db?: TenantDb;
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
  /** Chain depth of the WeldConnect run that caused this mutation, if any. */
  workflowDepth?: number;
}

/**
 * Context-free entity event publisher. Same hub enqueue as `publishEntityEvent`
 * but takes plain `{ env, … }` instead of a Hono `Context`, and awaits the send
 * (safe to call inside a Workflow `step.do` or a webhook handler).
 */
export async function publishEntityEventRaw(params: PublishEntityEventRawParams): Promise<void> {
  const {
    source = 'system',
    env,
    workspaceId,
    userId,
    entityType,
    action,
    entityId,
    data,
    changes,
    accessUserIds,
    workflowDepth,
  } = params;
  const tasks = enqueueHubEntityEvent(
    { env, workspaceId, userId, entityType, action, entityId, data, changes, accessUserIds, workflowDepth },
    source,
  );
  await Promise.allSettled(tasks);
}
