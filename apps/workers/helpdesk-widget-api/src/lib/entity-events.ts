/**
 * Entity Events — widget-side fan-out for analytics + realtime.
 *
 * Phase 0: stopped producing to the orphan `ENTITY_EVENTS` Cloudflare Queue
 * (no consumer in-repo). Widget workflows continue via the `WORKFLOW_WORKER`
 * service binding (inline). Analytics + realtime remain until a later hub phase.
 */

import type { Context } from 'hono';
import type { Env } from '../index';
import { generateId } from './id';
import { RealtimePublisher } from '@weldsuite/realtime/server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityAction = 'created' | 'updated' | 'deleted' | 'archived';
export type EventSource = 'web' | 'mobile' | 'api' | 'system' | 'widget';

export interface EntityEventMessage<T = Record<string, unknown>> {
  /** Unique event id (evt_…) */
  id: string;
  /** Composite key, e.g. "helpdesk_conversation:created" */
  eventType: `${string}:${EntityAction}`;
  /** Singular entity name, e.g. "helpdesk_conversation" */
  entityType: string;
  /** Primary key of the affected entity */
  entityId: string;
  /** The action that occurred */
  action: EntityAction;
  /** Payload — the entity data after the mutation */
  data: T;
  /** Only present on "updated" events */
  changes?: Record<string, { old: unknown; new: unknown }>;
  /** Contextual information */
  metadata: {
    workspaceId: string;
    userId: string;
    timestamp: string;
    source: EventSource;
  };
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

interface PublishParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<{ Bindings: Env; Variables: any }>;
  entityType: string;
  entityId: string;
  action: EntityAction;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
}

/**
 * Fire-and-forget: fan out a widget entity mutation to analytics + realtime.
 *
 * Does **not** enqueue on `ENTITY_EVENTS` (orphan producer removed in Phase 0).
 * Workflow triggers use `WORKFLOW_WORKER` inline elsewhere.
 */
export function publishEntityEvent({
  c,
  entityType,
  entityId,
  action,
  data,
  changes,
}: PublishParams): void {
  const message: EntityEventMessage = {
    id: generateId('evt'),
    eventType: `${entityType}:${action}`,
    entityType,
    entityId,
    action,
    data,
    ...(changes ? { changes } : {}),
    metadata: {
      workspaceId: (c.get('workspaceId') as string) ?? '',
      userId: (c.get('widgetId') as string) ?? 'widget-customer',
      timestamp: new Date().toISOString(),
      source: 'widget',
    },
  };

  // Analytics queue
  const analyticsQueue = (c.env as Env).ANALYTICS_EVENTS;
  if (analyticsQueue) {
    const analyticsPromise = analyticsQueue
      .send(message)
      .then(() => {
        console.log(`[EntityEvents] Published analytics ${message.eventType} for ${entityId}`);
      })
      .catch((err: unknown) => {
        console.error('[EntityEvents] Failed to publish analytics event:', err);
      });
    c.executionCtx.waitUntil(analyticsPromise);
  }

  // Publish to realtime workspace channel for real-time client sync
  const workspaceId = message.metadata.workspaceId;
  if (workspaceId && (c.env as Env).REALTIME) {
    const realtimePromise = (async () => {
      try {
        const rt = new RealtimePublisher((c.env as Env).REALTIME!);
        await rt.helpdeskEvent(workspaceId as string, message.eventType, message);
        console.log(`[EntityEvents] Published ${message.eventType} to realtime workspace:${workspaceId}`);
      } catch (err) {
        console.error('[EntityEvents] Failed to publish realtime platform event:', err);
      }
    })();
    c.executionCtx.waitUntil(realtimePromise);
  }
}
