/**
 * Entity event types — wire format shared between publishers (api-worker,
 * app-api) and queue consumers (audit-log-worker, analytics-worker,
 * helpdesk-workflow-worker).
 *
 * This module is intentionally runtime-dependency-free so consumer workers
 * can import it from `@weldsuite/entity-events/types` without pulling in
 * the publisher / dispatch deps (drizzle, realtime, trigger.dev).
 */

/** Physical actions that publishers emit. Subscribers see these on the wire. */
export type EntityAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'archived'
  | 'added'
  | 'removed'
  | 'joined'
  | 'left'
  | 'approved'
  | 'rejected'
  | 'started'
  | 'completed'
  | 'cancelled'
  // Escape hatch — keeps autocomplete for the listed members while still
  // allowing rare custom actions (e.g. 'email_sent', 'use_external') used
  // by a handful of routes today.
  | (string & {});

export type EventSource = 'web' | 'mobile' | 'api' | 'system';

export interface EntityEventMessage<T = Record<string, unknown>> {
  /** Unique event id (evt_…). */
  id: string;
  /** Composite key, e.g. "personal_task:created". */
  eventType: `${string}:${string}`;
  /** Singular entity name, e.g. "personal_task". */
  entityType: string;
  /** Primary key of the affected entity. */
  entityId: string;
  /** The action that occurred. */
  action: EntityAction;
  /** Payload — the entity data after the mutation. */
  data: T;
  /** Only present on "updated" events. */
  changes?: Record<string, { old: unknown; new: unknown }>;
  /** Contextual information. */
  metadata: {
    workspaceId: string;
    userId: string;
    timestamp: string;
    source: EventSource;
  };
}
