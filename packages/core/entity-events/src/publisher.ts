/**
 * publishEntityEvent — the orchestrator.
 *
 * Fans out a single entity mutation to exactly two places:
 *   1. ENTITY_EVENTS queue → entity-events-worker, which dispatches to every
 *      registered consumer: audit, analytics, outbound webhooks, workflow
 *      triggers, and semantic search
 *   2. REALTIME service binding → WorkspaceHub DO (@weldsuite/realtime)
 *
 * Realtime is the deliberate permanent exception: its latency is directly
 * visible in the UI, and it is a service-binding fetch rather than a queue, so
 * it costs nothing on the write path. Everything else lives behind the queue,
 * and adding another consumer never touches this file.
 *
 * Note what is no longer here. This used to be six sinks, four of them separate
 * queue sends, two of them tenant-DB reads opened inside `waitUntil` on every
 * single mutation. A mutation now costs one queue send and one fetch.
 *
 * Both sinks are independently optional — a missing binding logs a warning
 * and the other still fires. Wrapped in `executionCtx.waitUntil(...)` so the
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
import type { TenantDb } from './internal-types';

// ---------------------------------------------------------------------------
// Env shape required by the publisher (structural — workers' own Env types
// extend this naturally)
// ---------------------------------------------------------------------------

export interface EntityEventPublisherEnv {
  /** The dispatcher queue — entity-events-worker fans this out to consumers. */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  REALTIME?: Fetcher;
}

export interface EntityEventPublisherVariables {
  workspaceId: string;
  userId: string;
  /**
   * No longer read by the publisher — the consumers that needed a tenant DB
   * moved to the dispatcher, which resolves its own. Kept because route
   * handlers set it for their own use and removing it from the contract would
   * churn every call site for nothing.
   */
  tenantDb?: TenantDb;
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
  const { env, workspaceId, userId, entityType, action, entityId, data, changes, accessUserIds } =
    params;

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

  // 1. Dispatcher queue — audit, analytics, webhooks, workflow triggers and
  // search all hang off this one message, via entity-events-worker's registry.
  if (env.ENTITY_EVENTS) {
    tasks.push(
      env.ENTITY_EVENTS.send(message)
        .then(() => console.log(`[EntityEvents] Dispatched ${message.eventType} for ${entityId}`))
        .catch((err: unknown) => console.error('[EntityEvents] Failed to dispatch event:', err)),
    );
  }

  // 2. Cloudflare DO realtime
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
  /**
   * No longer used — the sinks that needed it are dispatcher consumers now,
   * and the dispatcher resolves its own tenant DB. Still accepted so the eight
   * existing call sites keep compiling; drop it when convenient.
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
}

/**
 * Context-free entity event publisher. Same fan-out as `publishEntityEvent`
 * but takes a plain `env` instead of a Hono `Context`, and awaits every sink
 * (safe to call inside a Workflow `step.do` or a webhook handler).
 */
export async function publishEntityEventRaw(params: PublishEntityEventRawParams): Promise<void> {
  const { source = 'system', db: _db, ...rest } = params;
  const tasks = fanOutEntityEvent(rest, source);
  await Promise.allSettled(tasks);
}
