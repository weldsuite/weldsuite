/**
 * Audit logs on the public API: `GET /v1/audit-logs` and
 * `GET /v1/audit-logs/:id`, scope `audit_logs:read`. Read-only, so a SIEM can
 * poll it.
 *
 * An item is `{ id, createdAt, action, entityType, entityId, description,
 * changes, performedBy, performedByName, ipAddress, source }`; `source` is
 * `metadata.source`. The `data` snapshot and the rest of the metadata are not
 * exposed.
 *
 * Filters: `action`, `entityType`, `entityId`, `performedBy` (exact),
 * `since` / `until` (ISO timestamps on `createdAt`, both inclusive). `order` is
 * `desc` (default, newest first) or `asc` (oldest first, to poll forward).
 * `cursor` is the `id` of the last row of the previous page.
 *
 * Rows are ordered and the cursor is compared on `(date_trunc('milliseconds',
 * created_at), id)`: `created_at` has microseconds, the cursor row is read
 * back at milliseconds, and comparing the two directly would skip or repeat
 * the rows that share the cursor's millisecond. Several rows can share a
 * millisecond; a client that polls with `since` alone should de-duplicate on
 * `id`.
 *
 * Audit rows are never written through the public API: writes answer 405.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, error, list, success } from '../../../lib/response';
import { clampLimit } from '../../../lib/pagination';
import { WRITE_METHODS } from '../accounting/read-only-route';
import { schema } from '../../../db';

const READ_SCOPE = 'audit_logs:read';

const t = schema.auditLogs;
type AuditRow = typeof t.$inferSelect;

const isoTimestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Expected an ISO 8601 timestamp');

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  action: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  performedBy: z.string().min(1).optional(),
  since: isoTimestamp.optional(),
  until: isoTimestamp.optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

/** `created_at` cut to the millisecond: what rows are ordered and the cursor is compared on. */
const MS = sql`date_trunc('milliseconds', ${t.createdAt})`;
/** The same instant as text, exact to the millisecond. */
const MS_TEXT = sql<string>`to_char(date_trunc('milliseconds', ${t.createdAt}), 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;

export interface PublicAuditLog {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  changes: AuditRow['changes'];
  performedBy: string | null;
  performedByName: string | null;
  ipAddress: string | null;
  source: string | null;
}

function toPublic(row: Pick<AuditRow, 'id' | 'createdAt' | 'action' | 'entityType' | 'entityId' | 'description' | 'changes' | 'performedBy' | 'performedByName' | 'ipAddress'> & { source: string | null }): PublicAuditLog {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    description: row.description,
    changes: row.changes ?? null,
    performedBy: row.performedBy ?? null,
    performedByName: row.performedByName ?? null,
    ipAddress: row.ipAddress ?? null,
    source: row.source,
  };
}

/** Only these columns are ever selected: `data` and the rest of `metadata` stay in the database. */
const PUBLIC_COLUMNS = {
  id: t.id,
  createdAt: t.createdAt,
  action: t.action,
  entityType: t.entityType,
  entityId: t.entityId,
  description: t.description,
  changes: t.changes,
  performedBy: t.performedBy,
  performedByName: t.performedByName,
  ipAddress: t.ipAddress,
  source: sql<string | null>`${t.metadata}->>'source'`,
};

const app = new Hono<HonoEnv>();

app.get('/', requireScope(READ_SCOPE), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const limit = clampLimit(q.limit);
  const order = q.order ?? 'desc';

  const filters: SQL[] = [];
  if (q.action) filters.push(eq(t.action, q.action));
  if (q.entityType) filters.push(eq(t.entityType, q.entityType));
  if (q.entityId) filters.push(eq(t.entityId, q.entityId));
  if (q.performedBy) filters.push(eq(t.performedBy, q.performedBy));
  if (q.since) filters.push(gte(t.createdAt, new Date(q.since)));
  if (q.until) filters.push(lte(t.createdAt, new Date(q.until)));

  const conditions = [...filters];
  if (q.cursor) {
    const [cursorRow] = await db.select({ id: t.id, ms: MS_TEXT }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (!cursorRow) return error.badRequest(c, 'Invalid cursor', { field: 'cursor' });
    const at = `${cursorRow.ms}Z`;
    conditions.push(
      order === 'asc'
        ? sql`(${MS}, ${t.id}) > (${at}::timestamp, ${cursorRow.id})`
        : sql`(${MS}, ${t.id}) < (${at}::timestamp, ${cursorRow.id})`,
    );
  }

  const direction = order === 'asc' ? asc : desc;
  const [rows, countResult] = await Promise.all([
    db
      .select(PUBLIC_COLUMNS)
      .from(t)
      .where(and(...conditions))
      .orderBy(direction(MS), direction(t.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(and(...filters)),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.id : null;
  return list(c, page.map(toPublic), cursorPagination(Number(countResult[0]?.count ?? 0), hasMore, nextCursor));
});

app.get('/:id', requireScope(READ_SCOPE), async (c) => {
  const id = c.req.param('id');
  const [row] = await c.get('tenantDb').select(PUBLIC_COLUMNS).from(t).where(eq(t.id, id)).limit(1);
  if (!row) return error.notFound(c, 'Audit log', id);
  return success(c, toPublic(row));
});

// The audit log is written by the platform only. Still 401 without a session, like the other read-only resources.
app.on([...WRITE_METHODS], '/*', (c) => {
  if (!c.get('apiSession')) return error.unauthorized(c);
  c.header('Allow', 'GET, HEAD, OPTIONS');
  return c.json(
    { error: { code: 'METHOD_NOT_ALLOWED', message: 'The audit logs resource is read-only through the public API.' } },
    405,
  );
});

export default app;
