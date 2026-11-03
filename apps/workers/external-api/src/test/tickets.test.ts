/**
 * The legacy `helpdesk_tickets` routes the published app SDK still reads
 * (pglite): list with its filters, detail, update (custom field values
 * mirrored into the typed table), soft delete and the nested messages, all
 * answering with the deprecation headers that point at /v1/conversations.
 * Opening a ticket is in conversations.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db
    .insert(schema.helpdeskTickets)
    .values([
      {
        id: 'tkt_ext_one',
        ticketNumber: 'EXT-1',
        customerName: 'Ada Ticket',
        customerEmail: 'ada@tickets.test',
        subject: 'Printer on fire',
        status: 'open',
        priority: 'high',
        category: 'hardware',
      },
      {
        id: 'tkt_ext_two',
        ticketNumber: 'EXT-2',
        customerName: 'Bob Ticket',
        customerEmail: 'bob@tickets.test',
        subject: 'Password reset',
        status: 'closed',
        priority: 'low',
      },
    ] as (typeof schema.helpdeskTickets.$inferInsert)[])
    .onConflictDoNothing();
  await db
    .insert(schema.customFieldDefinitions)
    .values({
      id: 'cfd_ext_ticket_plan',
      entityType: 'ticket',
      name: 'Plan',
      slug: 'ext_plan',
      fieldType: 'text',
    } as typeof schema.customFieldDefinitions.$inferInsert)
    .onConflictDoNothing();
}, 60_000);

const api = (scopes = ['tickets:read', 'tickets:write']) => createExternalTestApp({ scopes, tenantDb: db }).request;
const body = (method: string, value: unknown): RequestInit => ({ method, headers: JSON_HEADERS, body: JSON.stringify(value) });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

function expectDeprecated(res: Response) {
  expect(res.headers.get('Deprecation')).toBe('true');
  expect(res.headers.get('Link')).toBe('</v1/conversations>; rel="successor-version"');
}

describe('/v1/tickets · the legacy ticket rows', () => {
  it('lists with filters and reads one, marking every answer deprecated', async () => {
    const request = api();
    const listed = await request('/v1/tickets?search=Printer&status=open&priority=high&category=hardware');
    expect(listed.status).toBe(200);
    expectDeprecated(listed);
    expect((await data<{ id: string }[]>(listed)).map((t) => t.id)).toEqual(['tkt_ext_one']);
    expect(await data<{ id: string }[]>(await request('/v1/tickets?search=EXT-&limit=1'))).toHaveLength(1);

    const one = await request('/v1/tickets/tkt_ext_two');
    expect(one.status).toBe(200);
    expectDeprecated(one);
    const missing = await request('/v1/tickets/tkt_missing');
    expect(missing.status).toBe(404);
    expectDeprecated(missing);
    const refused = await api(['unrelated:read'])('/v1/tickets');
    expect(refused.status).toBe(403);
    expectDeprecated(refused);
  });

  it('updates a ticket and mirrors its custom fields into the typed values', async () => {
    const request = api();
    const res = await request('/v1/tickets/tkt_ext_one', body('PATCH', { status: 'pending', customFields: { ext_plan: 'pro' } }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await data(res)).toMatchObject({ status: 'pending', customFields: { ext_plan: 'pro' } });
    const read = await data<{ customFields: Record<string, unknown> }>(await request('/v1/tickets/tkt_ext_one'));
    expect(read.customFields).toEqual({ ext_plan: 'pro' });
    const listed = await data<{ id: string; customFields: unknown }[]>(await request('/v1/tickets?search=Printer'));
    expect(listed[0]?.customFields).toEqual({ ext_plan: 'pro' });

    expect((await request('/v1/tickets/tkt_ext_one', body('PATCH', { subject: 'Printer still on fire' }))).status).toBe(200);
    expect((await request('/v1/tickets/tkt_missing', body('PATCH', { status: 'open' }))).status).toBe(404);
  });

  it('adds and lists messages on a ticket', async () => {
    const request = api();
    expect((await request('/v1/tickets/tkt_ext_two/messages', body('POST', { authorName: 'A', authorEmail: 'a@x.test' }))).status).toBe(400);
    expect((await request('/v1/tickets/tkt_ext_two/messages', body('POST', { body: 'Hi' }))).status).toBe(400);
    expect(
      (await request('/v1/tickets/tkt_missing/messages', body('POST', { body: 'Hi', authorName: 'A', authorEmail: 'a@x.test' }))).status,
    ).toBe(404);
    const created = await request(
      '/v1/tickets/tkt_ext_two/messages',
      body('POST', { body: 'Have you tried turning it off?', authorName: 'Agent', authorEmail: 'agent@x.test', authorType: 'agent', subject: 'Re' }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    expectDeprecated(created);
    const message = await data<{ id: string; ticketId: string }>(created);
    expect(message.ticketId).toBe('tkt_ext_two');
    const listed = await request('/v1/tickets/tkt_ext_two/messages?limit=10');
    expect(listed.status).toBe(200);
    expect((await data<{ id: string }[]>(listed)).map((m) => m.id)).toEqual([message.id]);
  });

  it('soft-deletes a ticket', async () => {
    const request = api();
    const gone = await request('/v1/tickets/tkt_ext_two', { method: 'DELETE' });
    expect(gone.status).toBe(204);
    expectDeprecated(gone);
    expect((await request('/v1/tickets/tkt_ext_two')).status).toBe(404);
    expect((await request('/v1/tickets/tkt_ext_two', { method: 'DELETE' })).status).toBe(404);
  });
});
