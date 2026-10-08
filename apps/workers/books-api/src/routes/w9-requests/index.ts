/**
 * Online W-9 requests: /api/w9-requests (docs/plans/weldbooks-us.md, phase 7).
 *
 *   POST /             {partyId, email?, expiresInDays?}  creates a request and its link
 *   GET  /             requests (?partyId=&status=), newest first
 *   GET  /:id          one request
 *   POST /:id/cancel   a pending request: the link stops working
 *
 * The vendor fills the form on the public page (../public-w9). The response
 * to POST / carries the link once (`url`); only the token's hash is stored.
 * Nothing is emailed from here yet: the UI shows the link to copy or send
 * (`emailSent` is always false).
 *
 * Permissions: suppliers:update or taxes:create to request, suppliers:read or
 * taxes:read to list.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import {
  generateW9Token,
  sha256Hex,
  toW9RequestView,
  w9EventData,
  w9KvKey,
  w9Url,
  W9_DEFAULT_EXPIRY_DAYS,
  W9_MAX_EXPIRY_DAYS,
  type W9KvEntry,
} from '../../services/w9-requests';

const app = new Hono<{ Bindings: Env & { PLATFORM_URL?: string }; Variables: Variables }>();

const t = schema.w9Requests;

const createSchema = z.object({
  partyId: z.string().min(1).max(30),
  email: z.string().trim().email().max(255).optional(),
  expiresInDays: z.number().int().min(1).max(W9_MAX_EXPIRY_DAYS).default(W9_DEFAULT_EXPIRY_DAYS),
});

const STATUSES = ['pending', 'completed', 'expired', 'cancelled'];

// GET /
app.get('/', requirePermission('suppliers:read', 'taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const limit = Math.min(Math.max(Number.parseInt(q.limit || '50', 10) || 50, 1), 100);
    const now = new Date();
    const conditions = [eq(t.entityId, entityId)];
    if (q.partyId) conditions.push(eq(t.partyId, q.partyId));
    if (q.status && STATUSES.includes(q.status)) {
      // `expired` is a pending request past its date.
      if (q.status === 'expired') {
        conditions.push(sql`(${t.status} = 'expired' or (${t.status} = 'pending' and ${t.expiresAt} <= ${now}))`);
      } else if (q.status === 'pending') {
        conditions.push(sql`${t.status} = 'pending' and ${t.expiresAt} > ${now}`);
      } else {
        conditions.push(eq(t.status, q.status));
      }
    }
    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt)).limit(limit),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const total = Number(count[0]?.count ?? 0);
    return list(c, rows.map((row) => toW9RequestView(row, now)), cursorPagination(total, total > rows.length, null));
  } catch (err) {
    console.error('[books-api/w9-requests] list failed:', err);
    return error.internal(c, 'Failed to fetch W-9 requests');
  }
});

// GET /:id
app.get('/:id', requirePermission('suppliers:read', 'taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'W-9 request', id);
    return success(c, toW9RequestView(row));
  } catch (err) {
    console.error('[books-api/w9-requests] get failed:', err);
    return error.internal(c, 'Failed to fetch the W-9 request');
  }
});

// POST /: a new request replaces any earlier pending one for the same vendor
app.post('/', requirePermission('suppliers:update', 'taxes:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const [party] = await db
      .select()
      .from(schema.parties)
      .where(and(eq(schema.parties.id, data.partyId), isNull(schema.parties.deletedAt)))
      .limit(1);
    if (!party) return error.notFound(c, 'Contact', data.partyId);

    let email = data.email ?? null;
    if (!email && party.companyId) {
      const [company] = await db.select({ email: schema.companies.email }).from(schema.companies).where(eq(schema.companies.id, party.companyId)).limit(1);
      email = company?.email ?? null;
    } else if (!email && party.personId) {
      const [person] = await db.select({ email: schema.people.email }).from(schema.people).where(eq(schema.people.id, party.personId)).limit(1);
      email = person?.email ?? null;
    }

    const now = new Date();
    const superseded = await db
      .update(t)
      .set({ status: 'cancelled', updatedAt: now })
      .where(and(eq(t.partyId, party.id), eq(t.status, 'pending')))
      .returning();
    for (const old of superseded) {
      await c.env.WORKSPACE_CACHE.delete(w9KvKey(old.tokenHash));
      publishEntityEvent({ c, entityType: 'w9_request', entityId: old.id, action: 'updated', data: w9EventData(old) });
    }

    const token = generateW9Token();
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(now.getTime() + data.expiresInDays * 86_400_000);
    const id = generateId('w9r');
    const [row] = await db
      .insert(t)
      .values({
        id,
        entityId,
        partyId: party.id,
        email,
        tokenHash,
        status: 'pending',
        expiresAt,
        requestedBy: c.get('userId') ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) return error.internal(c, 'Failed to create the W-9 request');

    const entry: W9KvEntry = { orgId, requestId: id };
    await c.env.WORKSPACE_CACHE.put(w9KvKey(tokenHash), JSON.stringify(entry), {
      // KV needs at least 60 seconds.
      expirationTtl: Math.max(60, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
    });

    await writeAccountingAudit(c, db, { accountingEntityId: entityId, entityType: 'w9_request', entityId: id, action: 'created' });
    publishEntityEvent({ c, entityType: 'w9_request', entityId: id, action: 'created', data: w9EventData(row) });

    return success(c, { request: toW9RequestView(row), url: w9Url(c.env, token), emailSent: false }, 201);
  } catch (err) {
    console.error('[books-api/w9-requests] create failed:', err);
    return error.internal(c, 'Failed to create the W-9 request');
  }
});

// POST /:id/cancel
app.post('/:id/cancel', requirePermission('suppliers:update', 'taxes:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'W-9 request', id);
    if (row.status !== 'pending') {
      return error.conflict(c, `This request is ${row.status} and can't be cancelled`);
    }
    const [updated] = await db
      .update(t)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.status, 'pending')))
      .returning();
    if (!updated) return error.conflict(c, 'This request is no longer pending');
    await c.env.WORKSPACE_CACHE.delete(w9KvKey(row.tokenHash));

    await writeAccountingAudit(c, db, { accountingEntityId: row.entityId, entityType: 'w9_request', entityId: id, action: 'cancelled' });
    publishEntityEvent({ c, entityType: 'w9_request', entityId: id, action: 'updated', data: w9EventData(updated) });
    return success(c, toW9RequestView(updated));
  } catch (err) {
    console.error('[books-api/w9-requests] cancel failed:', err);
    return error.internal(c, 'Failed to cancel the W-9 request');
  }
});

export const w9RequestsRoutes = app;
