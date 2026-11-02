/**
 * Every /api/tickets route on pglite, refusals included: list filters and
 * paging, detail with typed custom field values, create (generated number,
 * contact auto-link, conversation link, custom field mirror), update, soft
 * delete, the tag merge and the agent reply. Runs against Rust in
 * conformance mode (rust/conformance/suites.json).
 *
 * Assignments here go to nobody or to the caller, so no notification goes
 * out; the notification paths have their own file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ticketsRoutes } from './index';

const USER = 'user_test_default';
let db: Database;

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function app(...keys: string[]) {
  return createTestApp('/api/tickets', ticketsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
}

async function seedTicket(id: string, n: number, overrides: Partial<typeof schema.helpdeskTickets.$inferInsert> = {}) {
  const at = new Date(Date.UTC(2026, 0, 1, 12, 0, n));
  await db.insert(schema.helpdeskTickets).values({
    id,
    ticketNumber: `TKT-SEED-${n}`,
    customerName: `Customer ${n}`,
    customerEmail: `c${n}@x.test`,
    subject: `Seeded ticket ${n}`,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedTicket('tkt_a', 1, { status: 'open', priority: 'high', channel: 'email', category: 'billing' });
  await seedTicket('tkt_b', 2, { status: 'pending', assigneeId: 'user_x', departmentId: 'dep_1', tags: ['vip'] });
  await seedTicket('tkt_c', 3, { contactId: 'per_1', ticketTypeId: 'ttype_1', subject: 'Needle in the subject' });
  await seedTicket('tkt_d', 4, { customFields: { legacy: 'kept', color: 'blue' } });
  await seedTicket('tkt_gone', 5, { deletedAt: new Date(Date.UTC(2026, 0, 2)) });
  const tie = new Date(Date.UTC(2026, 0, 3));
  await seedTicket('tkt_t1', 6, { createdAt: tie, updatedAt: tie });
  await seedTicket('tkt_t2', 7, { createdAt: tie, updatedAt: tie });

  await db.insert(schema.people).values({ id: 'per_jane', displayName: 'Jane', email: 'jane@known.test' });
  await db.insert(schema.helpdeskAgents).values({ id: 'agt_1', userId: USER, name: 'Agent Smith', email: 'smith@x.test' });
  await db.insert(schema.helpdeskTicketTypes).values({ id: 'ttype_1', name: 'Bug' });
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfld_color', entityType: 'ticket', name: 'Color', slug: 'color', fieldType: 'text' },
    { id: 'cfld_size', entityType: 'ticket', name: 'Size', slug: 'size', fieldType: 'number' },
    {
      id: 'cfld_tier',
      entityType: 'ticket',
      name: 'Tier',
      slug: 'tier',
      fieldType: 'single_select',
      options: [{ label: 'Gold', value: 'gold' }],
      ticketTypeId: 'ttype_1',
    },
    { id: 'cfld_due', entityType: 'ticket', name: 'Due', slug: 'due', fieldType: 'date' },
  ]);
  await db.insert(schema.customFieldValues).values([
    { id: 'cfv_1', fieldId: 'cfld_color', entityType: 'ticket', entityId: 'tkt_d', valueText: 'red' },
    { id: 'cfv_2', fieldId: 'cfld_size', entityType: 'ticket', entityId: 'tkt_d', valueNumber: 3.5 },
    {
      id: 'cfv_3',
      fieldId: 'cfld_due',
      entityType: 'ticket',
      entityId: 'tkt_a',
      valueDate: new Date(Date.UTC(2026, 4, 1)),
    },
  ]);

  await db.insert(schema.helpdeskConversations).values({
    id: 'conv_1',
    conversationNumber: 'CONV-1',
    customerName: 'Conv Customer',
    subject: 'Help me',
  });
  await db.insert(schema.helpdeskConversationMessages).values([
    {
      id: 'cm_1',
      conversationId: 'conv_1',
      authorName: 'Visitor',
      authorType: 'customer',
      content: 'Hello?',
      isPublic: true,
      createdAt: new Date(Date.UTC(2026, 0, 5, 1)),
    },
    {
      id: 'cm_2',
      conversationId: 'conv_1',
      authorName: '',
      authorEmail: 'agent@x.test',
      authorType: 'agent',
      authorId: 'user_y',
      content: 'Hi!',
      htmlContent: '<p>Hi!</p>',
      isPublic: true,
      createdAt: new Date(Date.UTC(2026, 0, 5, 2)),
    },
    {
      id: 'cm_3',
      conversationId: 'conv_1',
      authorName: 'Agent',
      content: 'internal',
      isPublic: false,
      createdAt: new Date(Date.UTC(2026, 0, 5, 3)),
    },
  ]);
}, 60_000);

describe('/api/tickets · list', () => {
  it('lists live tickets newest first, with custom fields laid over the blob', async () => {
    const res = await app('tickets:read').request('/api/tickets');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; customFields: Record<string, unknown> }> };
    expect(body.data.map((t) => t.id)).not.toContain('tkt_gone');
    expect(body.data.find((t) => t.id === 'tkt_d')?.customFields).toMatchObject({ legacy: 'kept', color: 'red' });
  });

  it('filters', async () => {
    const { request } = app('tickets:read');
    for (const query of [
      'status=open',
      'priority=high',
      'assigneeId=user_x',
      'departmentId=dep_1',
      'contactId=per_1',
      'channel=email',
      'category=billing',
      'ticketTypeId=ttype_1',
      'search=Needle',
      'search=c2@x',
      'search=TKT-SEED-4',
      'status=',
    ]) {
      expect((await request(`/api/tickets?${query}`)).status).toBe(200);
    }
  });

  it('pages with limit and cursor; an unknown cursor counts without the last condition', async () => {
    const { request } = app('tickets:read');
    const first = (await (await request('/api/tickets?limit=2')).json()) as { pagination: { cursor: string } };
    expect((await request(`/api/tickets?limit=2&cursor=${first.pagination.cursor}`)).status).toBe(200);
    expect((await request('/api/tickets?cursor=nope')).status).toBe(200);
    expect((await request('/api/tickets?status=open&search=Seeded&cursor=nope')).status).toBe(200);
    for (const limit of ['0', '-1', 'abc', '500']) {
      expect((await request(`/api/tickets?limit=${limit}`)).status).toBe(200);
    }
  });

  it('needs tickets:read', async () => {
    expect((await app().request('/api/tickets')).status).toBe(403);
  });
});

describe('/api/tickets/:id', () => {
  it('answers the hydrated ticket, 404 when missing or deleted', async () => {
    const { request } = app('tickets:read');
    expect((await request('/api/tickets/tkt_d')).status).toBe(200);
    expect((await request('/api/tickets/tkt_a')).status).toBe(200);
    expect((await request('/api/tickets/tkt_gone')).status).toBe(404);
    expect((await request('/api/tickets/nope')).status).toBe(404);
    expect((await app().request('/api/tickets/tkt_a')).status).toBe(403);
  });
});

describe('POST /api/tickets', () => {
  it('creates with a generated number, the email local part as name and the known contact', async () => {
    const res = await app('tickets:create').request(
      '/api/tickets',
      json({ customerName: '  ', customerEmail: 'jane@known.test', subject: 'Printer on fire' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; ticketNumber: string; status: string } };
    expect(data.ticketNumber).toMatch(/^TKT-/);
    expect(data.status).toBe('new');
    const [row] = await db.select().from(schema.helpdeskTickets).where(eq(schema.helpdeskTickets.id, data.id));
    expect(row?.customerName).toBe('jane');
    expect(row?.contactId).toBe('per_jane');
    expect(row?.channel).toBe('web');
  });

  it('creates with every field, the legacy priority, custom fields and a self-assignment', async () => {
    const res = await app('tickets:create').request(
      '/api/tickets',
      json({
        ticketNumber: 'CUSTOM-42',
        customerName: 'Bob',
        customerEmail: 'bob@x.test',
        subject: 'Full ticket',
        description: 'All the things',
        status: 'open',
        priority: 'normal',
        assigneeId: USER,
        contactId: 'per_explicit',
        departmentId: null,
        ticketTypeId: 'ttype_1',
        tags: ['a', 'b'],
        customFields: { color: 'green', size: '7', tier: 'gold', due: '2026-06-01', unknown: 'x' },
        source: 'phone',
        isPublic: true,
        metadata: { from: 'test' },
        stripped: 'not in the schema',
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const values = await db
      .select()
      .from(schema.customFieldValues)
      .where(eq(schema.customFieldValues.entityId, data.id));
    expect(values).toHaveLength(4);
  });

  it('takes the channel from source, and skips a custom field set that does not validate', async () => {
    const { request } = app('tickets:create');
    const res = await request(
      '/api/tickets',
      json({ customerEmail: 'c@x.test', subject: 'Source', source: 'chat', customFields: { size: 'big' } }),
    );
    expect(res.status).toBe(201);
    const empty = await request('/api/tickets', json({ customerName: '', customerEmail: 'z@x.test', subject: 'x' }));
    expect(empty.status).toBe(201);
  });

  it('links the conversation it was raised from', async () => {
    const res = await app('tickets:create').request(
      '/api/tickets',
      json({ customerName: 'Conv', customerEmail: 'conv@x.test', subject: 'From chat', priority: 'high', conversationId: 'conv_1' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const copied = await db
      .select()
      .from(schema.helpdeskTicketMessages)
      .where(eq(schema.helpdeskTicketMessages.ticketId, data.id));
    expect(copied).toHaveLength(2);
    const unlinked = await app('tickets:create').request(
      '/api/tickets',
      json({ customerName: 'Conv', customerEmail: 'conv@x.test', subject: 'Lost conversation', conversationId: 'conv_missing' }),
    );
    expect(unlinked.status).toBe(201);
  });

  it('refuses an invalid body', async () => {
    const { request } = app('tickets:create');
    for (const body of [
      { customerName: 'X', customerEmail: 'not-an-email', subject: 'X' },
      { customerEmail: 'x@x.test' },
      { customerEmail: 'x@x.test', subject: 'x', priority: 'blocker' },
      { customerEmail: 'x@x.test', subject: 'x', priority: 3 },
      { customerEmail: 'x@x.test', subject: 'x', status: 'gone', tags: [1] },
      { customerEmail: 'x@x.test', subject: 'x', source: 'x'.repeat(21) },
    ]) {
      expect((await request('/api/tickets', json(body))).status).toBe(400);
    }
  });

  it('needs tickets:create', async () => {
    const res = await app('tickets:read').request('/api/tickets', json({ customerEmail: 'x@x.test', subject: 'x' }));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/tickets/:id', () => {
  it('updates, mirrors custom fields of the new type, and refuses', async () => {
    const { request } = app('tickets:update');
    expect((await request('/api/tickets/tkt_a', json({ subject: 'Renamed', priority: 'normal', status: 'closed' }, 'PATCH'))).status).toBe(200);
    expect(
      (await request('/api/tickets/tkt_a', json({ ticketTypeId: 'ttype_1', customFields: { tier: 'gold' } }, 'PATCH'))).status,
    ).toBe(200);
    expect((await request('/api/tickets/tkt_a', json({ customFields: null, assigneeId: USER }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/tickets/tkt_b', json({ assigneeId: null, subject: null }, 'PATCH'))).status).toBe(400);
    expect((await request('/api/tickets/tkt_b', json({ assigneeId: null }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/tickets/tkt_gone', json({ subject: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await request('/api/tickets/tkt_a', json({ customerName: '' }, 'PATCH'))).status).toBe(400);
    expect((await request('/api/tickets/tkt_a', json({ priority: 'x' }, 'PATCH'))).status).toBe(400);
    expect((await app('tickets:read').request('/api/tickets/tkt_a', json({ subject: 'x' }, 'PATCH'))).status).toBe(403);
  });
});

describe('DELETE /api/tickets/:id', () => {
  it('soft-deletes', async () => {
    const { request } = app('tickets:delete');
    expect((await request('/api/tickets/tkt_t1', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/api/tickets/tkt_t1', { method: 'DELETE' })).status).toBe(404);
    expect((await app('tickets:read').request('/api/tickets/tkt_t2', { method: 'DELETE' })).status).toBe(403);
  });
});

describe('PATCH /api/tickets/:id/tags', () => {
  it('merges tags', async () => {
    const { request } = app('tickets:update');
    const res = await request('/api/tickets/tkt_b/tags', json({ tags: ['vip', 'new'] }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { tags: string[] } }).data.tags).toEqual(['vip', 'new']);
    expect((await request('/api/tickets/tkt_c/tags', json({ tags: ['x'] }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/tickets/tkt_gone/tags', json({ tags: ['x'] }, 'PATCH'))).status).toBe(404);
    expect((await request('/api/tickets/tkt_b/tags', json({}, 'PATCH'))).status).toBe(400);
    expect((await request('/api/tickets/tkt_b/tags', json({ tags: [1] }, 'PATCH'))).status).toBe(400);
    expect((await app('tickets:read').request('/api/tickets/tkt_b/tags', json({ tags: [] }, 'PATCH'))).status).toBe(403);
  });
});

describe('POST /api/tickets/:id/messages', () => {
  it('replies as the agent, notes internally, and refuses', async () => {
    const { request } = app('tickets:update');
    const reply = await request('/api/tickets/tkt_c/messages', json({ content: 'On it', contentHtml: '<b>On it</b>' }));
    expect(reply.status).toBe(201);
    expect(((await reply.json()) as { data: { authorName: string } }).data.authorName).toBe('Agent Smith');
    expect((await request('/api/tickets/tkt_c/messages', json({ content: 'note', isInternal: true }))).status).toBe(201);
    expect((await request('/api/tickets/tkt_gone/messages', json({ content: 'x' }))).status).toBe(404);
    expect((await request('/api/tickets/tkt_c/messages', json({ content: '' }))).status).toBe(400);
    expect((await app('tickets:read').request('/api/tickets/tkt_c/messages', json({ content: 'x' }))).status).toBe(403);
  });

  it('falls back to Agent without a roster row', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:update'), tenantDb: db, userId: 'user_no_agent' },
    });
    const res = await request('/api/tickets/tkt_c/messages', json({ content: 'Hi' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { authorName: string; authorEmail: string } }).data).toMatchObject({
      authorName: 'Agent',
      authorEmail: '',
    });
  });
});
