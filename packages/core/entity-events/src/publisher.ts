/**
 * publishEntityEvent — the orchestrator.
 *
 * Fans out a single entity mutation to:
 *   1. AUDIT_EVENTS queue (audit-log-worker)
 *   2. WORKFLOW_EVENTS queue (helpdesk-workflow-worker)
 *   3. ANALYTICS_EVENTS queue (analytics-worker)
 *   4. REALTIME service binding → WorkspaceHub DO (@weldsuite/realtime)
 *   5. Cloudflare Workflow dispatch via env.EXECUTE_WORKFLOW
 *
 * Each sink is independently optional — a missing binding logs a warning
 * and the rest still fire. Wrapped in `executionCtx.waitUntil(...)` so the
 * HTTP response is never blocked.
 *
 * Note: app-api emits only via the DO realtime system. Legacy entity-event publishing lives in
 * api-worker only; everything app-api owns is on the DO realtime system.
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
import { dispatchWebhookDeliveries } from './webhook-delivery';
import type { TenantDb } from './internal-types';

// ---------------------------------------------------------------------------
// Env shape required by the publisher (structural — workers' own Env types
// extend this naturally)
// ---------------------------------------------------------------------------

export interface EntityEventPublisherEnv extends WorkflowDispatchEnv {
  AUDIT_EVENTS?: Queue<EntityEventMessage>;
  WORKFLOW_EVENTS?: Queue<EntityEventMessage>;
  ANALYTICS_EVENTS?: Queue<EntityEventMessage>;
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

  // 1. Audit queue
  if (env.AUDIT_EVENTS) {
    tasks.push(
      env.AUDIT_EVENTS.send(message)
        .then(() => console.log(`[EntityEvents] Published audit event ${message.eventType} for ${entityId}`))
        .catch((err: unknown) => console.error('[EntityEvents] Failed to publish audit event:', err)),
    );
  }

  // 2. Workflow queue
  if (env.WORKFLOW_EVENTS) {
    tasks.push(
      env.WORKFLOW_EVENTS.send(message)
        .then(() => console.log(`[EntityEvents] Published workflow event ${message.eventType} for ${entityId}`))
        .catch((err: unknown) => console.error('[EntityEvents] Failed to publish workflow event:', err)),
    );
  }

  // 3. Analytics queue
  if (env.ANALYTICS_EVENTS) {
    tasks.push(
      env.ANALYTICS_EVENTS.send(message)
        .then(() => console.log(`[EntityEvents] Published analytics event ${message.eventType} for ${entityId}`))
        .catch((err: unknown) => console.error('[EntityEvents] Failed to publish analytics event:', err)),
    );
  }

  // 4. Cloudflare DO realtime
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

  if (!env.AUDIT_EVENTS && !env.WORKFLOW_EVENTS && !env.ANALYTICS_EVENTS && !env.REALTIME) {
    console.warn('[EntityEvents] No queue or realtime bindings available — skipping publish');
  }

  // 5. Outbound customer webhooks (external_webhooks subscriptions). No binding
  // required — reads straight off the tenant `db`, so this always runs; it's a
  // cheap no-op when no active webhook is subscribed to this event.
  if (workspaceId) {
    tasks.push(
      dispatchWebhookDeliveries({
        db,
        workspaceId,
        entityType,
        action,
        eventId: message.id,
        data,
      }).catch((err: unknown) => console.error('[EntityEvents] Failed to dispatch webhook deliveries:', err)),
    );
  }

  // 6. Inline workflow trigger matching (CF Workflows binding)
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
