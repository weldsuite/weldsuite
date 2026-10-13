/**
 * The two ports a WeldReach domain function reaches the outside world through.
 *
 * Only a worker holds the Hono context (entity events) and the D1 schedule
 * index (waking the send sweep), so the domain takes them as callbacks and the
 * worker wires them: `publishEntityEvent({ c, ... })` and `markWorkspaceDue(...)`.
 */

import type { EntityType } from '@weldsuite/entity-events/events';
import type { EntityAction } from '@weldsuite/entity-events/types';

export interface ReachEvent {
  entityType: EntityType;
  action: EntityAction;
  entityId: string;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
}

/** Where entity events go. Called after the write, before the function returns. */
export type ReachEventSink = (event: ReachEvent) => Promise<void> | void;

/**
 * Wake the send sweep: this workspace has outreach due at `at` (never in the
 * past; "now" when it is due at once). The caller maps it to
 * `markWorkspaceDue(SCHEDULE_INDEX, kind, clerkOrgId, at)`.
 */
export type ReachDuePort = (kind: 'reach_send', at: Date) => Promise<void> | void;

/** A sink that drops every event, for callers that have nobody to tell. */
export const noEvents: ReachEventSink = () => undefined;
