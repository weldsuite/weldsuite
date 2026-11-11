/**
 * Audit log streams: where a workspace's audit log is pushed (a SIEM).
 * `/api/audit-log-streams`.
 *
 * Permissions: every route needs `general:update`, the list included (a
 * collector URL can carry a secret). By default only OWNER and ADMIN hold it
 * (the member role has `general:read` only): sending the audit log to an
 * outside URL is an administrator action.
 *
 * The collector token is write-only: stored field-encrypted with the tenant
 * keyring (`token_encrypted`), never returned, never put in an entity event or
 * a log. Rows carry `hasToken` instead. Entity events carry less still
 * (`toEventData`): the audit log they end up in is open to `general:read`.
 * Delivery itself runs in audit-log-worker
 * (`@weldsuite/core-domain/audit-streams`); this route only manages the
 * streams and sends the test event.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { asc, eq, sql } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  MAX_AUDIT_LOG_STREAMS,
  createAuditLogStreamSchema,
  updateAuditLogStreamSchema,
  type AuditLogStream as AuditLogStreamView,
} from '@weldsuite/core-api-client/schemas/audit-log-streams';
import { sendAuditLogStreamTest } from '@weldsuite/core-domain/audit-streams';
import { encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { checkSafeUrl } from '@weldsuite/worker-kit/safe-url';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.auditLogStreams;

type StreamRow = typeof t.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The row as the API shows it: no `tokenEncrypted`, a `hasToken` flag in its place. */
export function toView(row: StreamRow): AuditLogStreamView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    hasToken: row.tokenEncrypted !== null,
    settings: row.settings ?? null,
    status: row.status,
    cursorCreatedAt: iso(row.cursorCreatedAt),
    lastDeliveredAt: iso(row.lastDeliveredAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    deliveredCount: row.deliveredCount,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What an entity event carries about a stream, on create, update and delete
 * alike: which stream, and nothing a member may not read. The audit log stores
 * event data and `GET /api/audit-logs` shows it to everyone with
 * `general:read`, while these routes need `general:update`: no `url` (it can
 * carry a secret), no `settings`, no `lastError` (it can quote what the
 * destination answered), no cursor and no counters.
 */
export function toEventData(row: StreamRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    hasToken: row.tokenEncrypted !== null,
  };
}

// The list needs the write permission too: a collector URL can carry a secret in its path or query.
app.get('/', requirePermission('general:update'), async (c) => {
  const rows = await c.get('tenantDb').select().from(t).orderBy(asc(t.createdAt), asc(t.id));
  return list(c, rows.map(toView), cursorPagination(rows.length, false, null));
});

app.post('/', requirePermission('general:update'), zValidator('json', createAuditLogStreamSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');

  const safe = checkSafeUrl(body.url);
  if (!safe.ok) return error.badRequest(c, safe.reason, { field: 'url' });

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(t);
  if (Number(count) >= MAX_AUDIT_LOG_STREAMS) {
    return error.conflict(c, `A workspace can have at most ${MAX_AUDIT_LOG_STREAMS} audit log streams`, { limit: MAX_AUDIT_LOG_STREAMS });
  }

  // A new stream starts at "now": the cursor is the creation time, so nothing older is sent.
  const now = new Date();
  const [row] = await db
    .insert(t)
    .values({
      id: generateId('als'),
      name: body.name,
      type: body.type,
      url: safe.url.toString(),
      tokenEncrypted: body.token ? await encryptField(body.token, keyringFromEnv(c.env)) : null,
      settings: body.settings ?? null,
      status: 'active',
      cursorCreatedAt: now,
      createdById: c.get('userId'),
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const view = toView(row);
  publishEntityEvent({ c, entityType: 'audit_log_stream', action: 'created', entityId: view.id, data: toEventData(row) });
  return success(c, view, 201);
});

app.patch('/:id', requirePermission('general:update'), zValidator('json', updateAuditLogStreamSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');

  const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  if (!existing) return error.notFound(c, 'Audit log stream', id);

  const update: Partial<typeof t.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) update.name = body.name;
  if (body.type !== undefined) update.type = body.type;
  if (body.url !== undefined) {
    const safe = checkSafeUrl(body.url);
    if (!safe.ok) return error.badRequest(c, safe.reason, { field: 'url' });
    update.url = safe.url.toString();
  }
  if (body.settings !== undefined) update.settings = body.settings;
  if (body.token !== undefined) {
    update.tokenEncrypted = body.token === null ? null : await encryptField(body.token, keyringFromEnv(c.env));
  }
  if (body.status !== undefined) {
    update.status = body.status;
    if (body.status === 'active') {
      update.consecutiveFailures = 0;
      update.lastError = null;
    }
  }

  const [row] = await db.update(t).set(update).where(eq(t.id, id)).returning();
  const view = toView(row);
  publishEntityEvent({ c, entityType: 'audit_log_stream', action: 'updated', entityId: id, data: toEventData(row) });
  return success(c, view);
});

app.delete('/:id', requirePermission('general:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  if (!existing) return error.notFound(c, 'Audit log stream', id);

  await db.delete(t).where(eq(t.id, id));
  publishEntityEvent({ c, entityType: 'audit_log_stream', action: 'deleted', entityId: id, data: toEventData(existing) });
  return noContent(c);
});

/**
 * Send one synthetic event to the destination now. The answer is the
 * destination's, not ours: a refusal is `200 { ok: false, status, error }`.
 * Touches no cursor and no counter.
 */
app.post('/:id/test', requirePermission('general:update'), async (c) => {
  const id = c.req.param('id');
  const [row] = await c.get('tenantDb').select().from(t).where(eq(t.id, id)).limit(1);
  if (!row) return error.notFound(c, 'Audit log stream', id);

  const result = await sendAuditLogStreamTest(row, {
    keyring: keyringFromEnv(c.env),
    workspaceId: c.get('workspaceId'),
  });
  return success(c, result);
});

export const auditLogStreamsRoutes = app;
