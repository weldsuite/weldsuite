/**
 * Entity events a service wants published. Services have no Hono context, so
 * they return these and the route (which owns `c`) publishes them after the
 * write, before it answers.
 */

import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Context } from 'hono';
import type { Env, Variables } from '../types';

export type MergeEntityType =
  | 'merge_team'
  | 'merge_issue'
  | 'merge_comment'
  | 'merge_label'
  | 'merge_cycle'
  | 'merge_connection'
  | 'merge_repository'
  | 'merge_pull_request'
  | 'merge_release'
  | 'merge_record_link'
  | 'merge_chat_subscription';

export interface PendingEvent {
  entityType: MergeEntityType;
  action: 'created' | 'updated' | 'deleted' | 'merged' | 'closed' | 'shipped' | 'agent_assigned';
  entityId: string;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
}

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export function publishEntityEvents(c: Ctx, events: PendingEvent[], source: 'api' | 'system' = 'api'): void {
  for (const event of events) {
    publishEntityEvent({
      c,
      // The catalog types each entity's payload; PendingEvent carries it as a record.
      entityType: event.entityType as 'merge_team',
      action: event.action,
      entityId: event.entityId,
      data: event.data as never,
      changes: event.changes ?? undefined,
      source,
    });
  }
}

/** Fields that differ between two snapshots, as an entity-event `changes` map (null when none). */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): Record<string, { old: unknown; new: unknown }> | null {
  const out: Record<string, { old: unknown; new: unknown }> = {};
  for (const f of fields) {
    if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) out[f] = { old: before[f], new: after[f] };
  }
  return Object.keys(out).length > 0 ? out : null;
}
