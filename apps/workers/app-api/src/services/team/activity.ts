/**
 * Member activity feed — a cursor-paginated view of audit_logs entries
 * performed by the given user across the tenant.
 *
 * Admin-only; the route layer enforces the permission.
 *
 * Ported from apps/core-api/src/services/team/activity.ts.
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';

export interface MemberActivityItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  createdAt: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
}

export interface ListMemberActivityParams {
  cursor?: string; // audit_log id used as keyset cursor
  limit?: number;
}

export interface ListMemberActivityResult {
  data: MemberActivityItem[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export async function listMemberActivity(
  db: Database,
  performedBy: string,
  params: ListMemberActivityParams = {},
): Promise<ListMemberActivityResult> {
  const { auditLogs } = schema;
  const limit = Math.min(params.limit ?? 25, 100);

  const conditions = [eq(auditLogs.performedBy, performedBy)];

  if (params.cursor) {
    const [cursorRow] = await db
      .select({ createdAt: auditLogs.createdAt, id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, params.cursor))
      .limit(1);
    if (cursorRow?.createdAt) {
      conditions.push(
        sql`(${auditLogs.createdAt} < ${cursorRow.createdAt} OR (${auditLogs.createdAt} = ${cursorRow.createdAt} AND ${auditLogs.id} < ${cursorRow.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const countConditions = params.cursor ? conditions.slice(0, -1) : conditions;

  const [rows, countRes] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        description: auditLogs.description,
        createdAt: auditLogs.createdAt,
        changes: auditLogs.changes,
      })
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(and(...countConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
    changes: r.changes ?? null,
  }));
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  const totalCount = Number(countRes[0]?.count ?? 0);

  return { data, totalCount, hasMore, cursor };
}
