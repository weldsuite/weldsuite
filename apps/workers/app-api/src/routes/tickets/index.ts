/**
 * Ticket routes — flat /api/tickets/* surface backed by `helpdeskTickets`.
 *
 * Permissions: tickets:read | tickets:create | tickets:update | tickets:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createTicketSchema, ticketPriority, updateTicketSchema } from '@weldsuite/app-api-client/schemas/tickets';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
  getDefinitionsForTicket,
} from '../../services/custom-field-values';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../db';
import type { Database } from '../../db';
import { linkConversationToTicket } from '../../services/helpdesk/conversation-to-ticket';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskTickets;

/**
 * Create payload, widened to the api-worker contract this route replaces.
 *
 * The WeldDesk ticket form posts three things the shared `createTicketSchema`
 * cannot express. Zod strips unknown keys, so before this widening the form's
 * `conversationId` vanished silently and the ticket was orphaned from the
 * conversation it was raised on.
 */
const createTicketCompatSchema = createTicketSchema.extend({
  /** Links the new ticket to the conversation it was raised from. */
  conversationId: z.string().optional(),
  /** api-worker's alias for the `channel` column (`channel: source || 'web'`). */
  source: z.string().max(20).optional(),
  /**
   * The form's priority select emits api-worker's vocabulary, whose 'normal'
   * is absent from `ticketPriority` ('medium' replaced it). `priority` is a
   * varchar(20) that already holds 'normal' rows, so accept both vocabularies
   * rather than 400 the form's default value or silently rewrite history.
   */
  priority: z.union([ticketPriority, z.literal('normal')]).optional(),
  /**
   * Relaxed from the shared schema's `min(1)`: back-office tickets submit an
   * empty name. The column is NOT NULL, so the handler restores api-worker's
   * email local-part fallback instead of rejecting the request.
   */
  customerName: z.string().max(255).optional(),
});

/**
 * Update payload, widened to match the create route above.
 *
 * `updateTicketSchema` is `createTicketSchema.partial()`, so it inherits the
 * narrow `ticketPriority` enum and would 400 on 'normal' — the vocabulary the
 * WeldDesk form emits and that the varchar(20) column already holds. The create
 * route accepts both; without the same widening here a ticket could be created
 * with a priority it could never be updated with. Widened at the route rather
 * than in `@weldsuite/app-api-client` because `updateTicketSchema` is also the
 * public contract for external-api and mcp-server, which should stay strict.
 */
const updateTicketCompatSchema = updateTicketSchema.extend({
  priority: z.union([ticketPriority, z.literal('normal')]).optional(),
});

/** Merge payload for `PATCH /:id/tags` — api-worker's `{ tags: string[] }`. */
const addTicketTagsSchema = z.object({
  tags: z.array(z.string()),
});

/** Reply payload for `POST /:id/messages` — api-worker's `ticketMessageSchema`. */
const ticketReplySchema = z.object({
  content: z.string().min(1),
  contentHtml: z.string().optional(),
  isInternal: z.boolean().optional().default(false),
});

app.get('/', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.priority !== undefined && q.priority !== '') conditions.push(eq(t.priority, q.priority));
  if (q.assigneeId !== undefined && q.assigneeId !== '') conditions.push(eq(t.assigneeId, q.assigneeId));
  if (q.departmentId !== undefined && q.departmentId !== '') conditions.push(eq(t.departmentId, q.departmentId));
  // Parity with api-worker's `/helpdesk/tickets`, which filtered on this.
  // `helpdesk_tickets.contactId` is indexed; without it a contact-scoped
  // caller silently receives the workspace's whole first page instead.
  if (q.contactId !== undefined && q.contactId !== '') conditions.push(eq(t.contactId, q.contactId));
  if (q.channel !== undefined && q.channel !== '') conditions.push(eq(t.channel, q.channel));
  if (q.category !== undefined && q.category !== '') conditions.push(eq(t.category, q.category));
  if (q.ticketTypeId !== undefined && q.ticketTypeId !== '') conditions.push(eq(t.ticketTypeId, q.ticketTypeId));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.subject, term), like(t.customerEmail, term), like(t.customerName, term), like(t.ticketNumber, term))!);
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    // Phase 3: customFields comes from the typed values table, not the blob.
    const hydrated = await hydrateCustomFields(db, 'ticket', data);
    return list(c, hydrated, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/tickets] list failed:', err);
    return error.internal(c, 'Failed to list tickets');
  }
});

app.get('/:id', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Ticket', id);
    // Phase 3: customFields comes from the typed values table, not the blob.
    return success(c, await hydrateCustomFieldsOne(db, 'ticket', row));
  } catch (err) {
    console.error('[app-api/tickets] get failed:', err);
    return error.internal(c, 'Failed to fetch ticket');
  }
});

app.post('/', requirePermission('tickets:create'), zValidator('json', createTicketCompatSchema), async (c) => {
  const db = c.get('tenantDb');
  // `conversationId` and `source` are transport-only: neither is a column on
  // `helpdesk_tickets`, so they must not reach the insert spread below.
  const { conversationId, source, ...data } = c.req.valid('json') as Record<string, any>;
  const id = generateId('tkt');
  const now = new Date();
  // `ticketNumber` is NOT NULL at the DB layer but optional in Zod.
  // Derive one (TKT-<timestamp>-<rand>) when the caller doesn't
  // provide one, so the route works for UIs that don't yet auto-
  // number tickets themselves.
  const ticketNumber =
    typeof data.ticketNumber === 'string' && data.ticketNumber.length > 0
      ? data.ticketNumber
      : `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  // NOT NULL column, but the form may submit ''. api-worker's fallback.
  const customerName =
    typeof data.customerName === 'string' && data.customerName.trim() !== ''
      ? data.customerName
      : String(data.customerEmail ?? '').split('@')[0] || 'Customer';
  const channel = data.channel ?? source ?? 'web';
  // Restores api-worker's auto-link to `people`; see `resolveContactId`. Must
  // override the `...data` spread below, not be shadowed by it.
  const contactId = await resolveContactId(db, data.contactId, data.customerEmail);
  try {
    await db
      .insert(t)
      .values({ id, ...data, ticketNumber, customerName, channel, contactId, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);

    // Pile B dual-write: mirror the customFields blob into the typed values
    // table, scoped to this ticket's type (a slug may repeat across types, so
    // slug->definition resolution must be ticket-type-aware).
    const ticketDefs = await getDefinitionsForTicket(db, data.ticketTypeId);
    await syncValuesForEntity(db, 'ticket', id, data.customFields, ticketDefs);

    if (conversationId) {
      await linkConversationToTicket(c.env, db, {
        conversationId,
        ticketId: id,
        ticketNumber,
        subject: data.subject,
        priority: data.priority,
        customerName,
        customerEmail: data.customerEmail,
        contactId,
        now,
      });
    }

    publishEntityEvent({
      c,
      entityType: 'ticket',
      entityId: id,
      action: 'created',
      data: { id, ticketNumber, subject: data.subject, status: data.status, priority: data.priority, assigneeId: data.assigneeId, contactId, departmentId: data.departmentId },
    });
    // Superset of `{ id }` — api-worker's callers read `ticketNumber`/`status`
    // off the create response, and adding fields keeps existing readers valid.
    return success(
      c,
      { id, ticketNumber, subject: data.subject, status: data.status ?? 'new', priority: data.priority, createdAt: now.toISOString() },
      201,
    );
  } catch (err) {
    console.error('[app-api/tickets] create failed:', err);
    return error.internal(c, 'Failed to create ticket');
  }
});

app.patch('/:id', requirePermission('tickets:update'), zValidator('json', updateTicketCompatSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Ticket', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    // Pile B dual-write, scoped to the ticket's type. ticketTypeId may be
    // changing in this patch; fall back to the stored one otherwise.
    const ticketDefs = await getDefinitionsForTicket(
      db,
      (data.ticketTypeId as string | null | undefined) ?? existing.ticketTypeId,
    );
    await syncValuesForEntity(db, 'ticket', id, data.customFields, ticketDefs);
    publishEntityEvent({
      c,
      entityType: 'ticket',
      entityId: id,
      action: 'updated',
      data: {
        id,
        ticketNumber: existing.ticketNumber,
        subject: (update.subject as string | null | undefined) ?? existing.subject,
        status: (update.status as string | null | undefined) ?? existing.status,
        priority: (update.priority as string | null | undefined) ?? existing.priority,
        assigneeId: (update.assigneeId as string | null | undefined) ?? existing.assigneeId,
        contactId: existing.contactId,
        departmentId: (update.departmentId as string | null | undefined) ?? existing.departmentId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/tickets] update failed:', err);
    return error.internal(c, 'Failed to update ticket');
  }
});

app.delete('/:id', requirePermission('tickets:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Ticket', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'ticket',
      entityId: id,
      action: 'deleted',
      data: { id, ticketNumber: existing.ticketNumber, subject: existing.subject, status: existing.status },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/tickets] delete failed:', err);
    return error.internal(c, 'Failed to delete ticket');
  }
});

/**
 * PATCH /:id/tags — MERGE tags into a ticket.
 *
 * Ported from api-worker `PATCH /helpdesk/tickets/:id/tags`, gate unchanged
 * (`tickets:update`, a tier MEMBER holds).
 *
 * Deliberately NOT the same as `PATCH /:id { tags }` above, which REPLACES the
 * column. This route unions the incoming tags with the existing ones, which is
 * what "add tags" has always meant to its callers — routing them at the generic
 * PATCH instead would silently delete every tag already on the ticket.
 */
app.patch('/:id/tags', requirePermission('tickets:update'), zValidator('json', addTicketTagsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { tags } = c.req.valid('json');
  try {
    const [existing] = await db
      .select({ tags: t.tags })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Ticket', id);

    const newTags = [...new Set([...(existing.tags || []), ...tags])];

    await db.update(t).set({ tags: newTags, updatedAt: new Date() }).where(and(eq(t.id, id), isNull(t.deletedAt)));

    // The catalog's TicketEventData has no `tags` — they are not part of the
    // published contract, so subscribers re-read the row. api-worker stuffed
    // them in anyway; the typed publisher rejects it. Same call the sibling
    // `PATCH /api/conversations/:id/tags` makes.
    publishEntityEvent({
      c,
      entityType: 'ticket',
      entityId: id,
      action: 'updated',
      data: { id },
    });

    return success(c, { id, tags: newTags });
  } catch (err) {
    console.error('[app-api/tickets] add tags failed:', err);
    return error.internal(c, 'Failed to add tags');
  }
});

/**
 * POST /:id/messages — reply to a ticket as the signed-in agent.
 *
 * Ported from api-worker `POST /helpdesk/tickets/:ticketId/messages`, gate
 * unchanged (`tickets:update`). Mirrors the shape of
 * `POST /api/conversations/:id/messages`, the sibling route on the other table.
 *
 * Two things the generic `POST /api/ticket-messages` does not do and a reply
 * must:
 *   - Derive the author from the Clerk session (`authorId` = userId,
 *     `authorType` = 'agent'). The generic route takes the author from the body,
 *     so a reply posted through it would carry whatever the client claimed —
 *     and `authorName` / `authorEmail` are NOT NULL, so the client-shaped
 *     `{ content }` payload would simply 500.
 *   - Bump the parent ticket's `updatedAt`, otherwise a replied-to ticket sinks
 *     down every "recently updated" list as if nothing had happened.
 *
 * `authorName` / `authorEmail` are resolved from the `helpdesk_agents` roster by
 * userId. api-worker hardcoded 'Agent' / '' here with a TODO; the roster is the
 * lookup that TODO was asking for, and it is the same table `/api/helpdesk-agents`
 * already serves. Falls back to api-worker's literals when the replying user has
 * no agent row.
 *
 * Returns the column-shaped row (`body` / `htmlBody` / `authorType`) — what the
 * platform's exported `TicketMessage` type declares and what `GET
 * /api/ticket-messages` already returns. api-worker's runtime shape here
 * (`content` / `senderType`) never matched its own read route.
 */
app.post('/:id/messages', requirePermission('tickets:update'), zValidator('json', ticketReplySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');
  const body = c.req.valid('json');
  const tm = schema.helpdeskTicketMessages;

  try {
    const [ticket] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, ticketId), isNull(t.deletedAt)))
      .limit(1);
    if (!ticket) return error.notFound(c, 'Ticket', ticketId);

    const author = await resolveAgentIdentity(db, userId);
    const id = generateId('tkm');
    const now = new Date();
    const isInternal = body.isInternal || false;

    const [message] = await db
      .insert(tm)
      .values({
        id,
        ticketId,
        body: body.content,
        htmlBody: body.contentHtml,
        authorType: 'agent',
        authorId: userId,
        authorName: author.name,
        authorEmail: author.email,
        // api-worker left both at their column defaults ('reply' / true), so an
        // internal note was stored as a public reply that merely happened to
        // carry isInternal — a self-contradictory row. Nothing reads either
        // column on this table today (checked across app-api, external-api and
        // the workflow engines), so setting them honestly costs nothing now and
        // keeps the next reader of `isPublic` from leaking notes to customers.
        type: isInternal ? 'note' : 'reply',
        isPublic: !isInternal,
        isInternal,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // A reply is activity on the ticket — keep the parent in step.
    await db.update(t).set({ updatedAt: now }).where(eq(t.id, ticketId));

    publishEntityEvent({
      c,
      entityType: 'helpdesk_message',
      entityId: id,
      action: 'created',
      data: { id, ticketId, authorId: userId, subject: message.subject },
    });

    return success(c, message, 201);
  } catch (err) {
    console.error('[app-api/tickets] reply failed:', err);
    return error.internal(c, 'Failed to add message');
  }
});

/**
 * Resolve the replying agent's display identity from the `helpdesk_agents`
 * roster. `helpdesk_ticket_messages.author_name` / `author_email` are both NOT
 * NULL, so this always resolves to *something* — api-worker's 'Agent' / ''
 * literals are the floor, not the target.
 *
 * Non-fatal: a reply must not fail because the roster lookup did.
 */
async function resolveAgentIdentity(db: Database, userId: string): Promise<{ name: string; email: string }> {
  const a = schema.helpdeskAgents;
  try {
    const [agent] = await db
      .select({ name: a.name, email: a.email })
      .from(a)
      .where(and(eq(a.userId, userId), isNull(a.deletedAt)))
      .limit(1);
    return { name: agent?.name || 'Agent', email: agent?.email || '' };
  } catch (err) {
    console.error('[app-api/tickets] agent identity lookup failed:', err);
    return { name: 'Agent', email: '' };
  }
}

/**
 * Resolve the `people` row a new ticket belongs to, restoring the auto-link
 * api-worker performed before this route replaced it
 * (`api-worker/src/routes/helpdesk/tickets.ts` — lookup by `customerEmail`).
 *
 * Not speculative parity: the only caller, the WeldDesk ticket form
 * (`components/welddesk/dynamic-ticket-form.tsx`), never sends `contactId`.
 * Without this lookup `helpdesk_tickets.contact_id` silently stops being
 * populated for every form-created ticket, and the `contactId` that
 * `mcp-server` exposes to agents always reads null. No screen filters on the
 * column today, so the loss is invisible until something reads it.
 *
 * An explicit `contactId` from the caller always wins — the lookup is a
 * fallback, never an override.
 *
 * Non-fatal by design (as in api-worker, which swallowed this with the note
 * "contacts table may not exist yet"): failing to enrich a ticket must not
 * fail a ticket the caller is entitled to create. The ticket is simply left
 * unlinked, exactly as it is today.
 */
async function resolveContactId(
  db: Database,
  provided: string | null | undefined,
  customerEmail: string | undefined,
): Promise<string | null> {
  if (provided) return provided;
  if (!customerEmail) return null;
  const p = schema.people;
  try {
    const [match] = await db
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.email, customerEmail), isNull(p.deletedAt)))
      .limit(1);
    return match?.id ?? null;
  } catch (err) {
    console.error('[app-api/tickets] contact auto-resolve failed:', err);
    return null;
  }
}

export const ticketsRoutes = app;
