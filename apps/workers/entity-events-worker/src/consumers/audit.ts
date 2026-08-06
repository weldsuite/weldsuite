/**
 * Audit log consumer — one `audit_logs` row per entity mutation.
 *
 * Replaces audit-log-worker, and fixes three things it got wrong:
 *
 *   - It wrote one row per message, each in its own round trip. This inserts the
 *     whole matched slice at once.
 *   - It looked up the actor's display name per event, so a batch of 25 events
 *     by one user cost 25 identical queries. Names are resolved once per batch.
 *   - Its writer wrapped everything in try/catch and logged, so a failed insert
 *     still acked the message and the audit row was simply gone. Errors now
 *     propagate and the batch retries.
 *
 * Idempotency comes from the unique `audit_logs.event_id` index: a retried batch
 * re-inserts the same rows and `onConflictDoNothing` drops them. That index is
 * what makes it safe for this consumer to share a queue with the others.
 */

import { inArray } from 'drizzle-orm';
import { defineConsumer } from '@weldsuite/entity-events/consumers';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import * as schema from '@weldsuite/db/schema';
import type { Env } from '../env';
import type { Database } from '../db';
import {
  buildDescription,
  getEntityDisplayName,
  stripModulePrefix,
  transformChanges,
} from '../audit/describe';

function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Resolve every actor in the batch in one query.
 *
 * Returns a map rather than throwing on failure: a missing display name is
 * cosmetic (the description falls back to "System"), and losing the whole audit
 * batch over it would be a worse trade.
 */
async function resolveUserNames(
  db: Database,
  userIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;

  try {
    const members = await db
      .select({ userId: schema.workspaceMembers.userId, name: schema.workspaceMembers.name })
      .from(schema.workspaceMembers)
      .where(inArray(schema.workspaceMembers.userId, userIds));

    for (const member of members) {
      if (member.name) names.set(member.userId, member.name);
    }
  } catch (err) {
    console.error('[audit] failed to resolve actor names:', err);
  }

  return names;
}

function toRow(event: EntityEventMessage, userName: string | null) {
  const data = event.data as Record<string, unknown>;
  const entityName = getEntityDisplayName(event.entityType, data);
  const changedFields = event.changes ? Object.keys(event.changes) : null;

  return {
    id: generateId('aud'),
    eventId: event.id,
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    description: buildDescription(
      event.action,
      event.entityType,
      entityName,
      userName,
      changedFields,
    ),
    changes: transformChanges(event.changes),
    data,
    performedBy: event.metadata.userId,
    performedByName: userName,
    metadata: {
      source: event.metadata.source,
      workspaceId: event.metadata.workspaceId,
      eventId: event.id,
      translationKey: `audit.${event.action}`,
      translationParams: {
        entityType: stripModulePrefix(event.entityType),
        entityName,
        changedFields: changedFields ?? undefined,
      },
    },
  };
}

export const auditConsumer = defineConsumer<Env>({
  name: 'audit',
  subscribes: '*',
  needsTenantDb: true,

  async handle(events, { db }) {
    if (!db) throw new Error('audit consumer requires a tenant db');

    const userIds = [...new Set(events.map((e) => e.metadata.userId).filter(Boolean))];
    const userNames = await resolveUserNames(db, userIds);

    const rows = events.map((event) =>
      toRow(event, userNames.get(event.metadata.userId) ?? null),
    );

    // One event id can only appear once per batch, but it can appear again in a
    // later retry — hence the conflict target rather than plain insert.
    await db.insert(schema.auditLogs).values(rows).onConflictDoNothing({
      target: schema.auditLogs.eventId,
    });

    console.log(`[audit] wrote ${rows.length} row(s)`);
  },
});
