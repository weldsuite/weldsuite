/**
 * Every /api/helpdesk-contacts route on pglite (the helpdesk view of the
 * shared `people` table): the list with its conversation count, filters and
 * cursor, the quick search, the detail, create and update with their refusals.
 * Runs against Rust in conformance mode (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskContactsRoutes } from './index';

const BASE = '/api/helpdesk-contacts';
let db: Database;

type Row = Record<string, unknown>;
interface ListBody {
  data: Row[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const app = (...keys: string[]) =>
  createTestApp(BASE, helpdeskContactsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const ids = (body: { data: Row[] }) => body.data.map((r) => r.id);
const at = (s: number) => new Date(Date.UTC(2026, 2, 1, 9, 0, s));

async function person(id: string, n: number, extra: Partial<typeof schema.people.$inferInsert> = {}) {
  await db.insert(schema.people).values({
    id,
    displayName: `Person ${n}`,
    createdAt: at(n),
    updatedAt: at(n),
    ...extra,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await person('per_a', 1, { firstName: 'Anna', lastName: 'Archer', fullName: 'Anna Archer', email: 'anna@x.test' });
  await person('per_b', 2, { firstName: 'Ben', lastName: 'Baker', fullName: 'Ben Baker', email: 'ben@x.test', status: 'inactive' });
  await person('per_c', 3, {
    firstName: 'Cleo',
    fullName: 'Cleo',
    email: 'cleo@needle.test',
    directPhone: '+31 20 000',
    notes: 'VIP',
    interests: ['billing'],
    avatarUrl: 'https://x/c.png',
    lastContactedAt: at(30),
  });
  const tie = new Date(Date.UTC(2026, 2, 2));
  await person('per_t1', 4, { firstName: 'Tie', lastName: 'One', fullName: 'Tie One', createdAt: tie, updatedAt: tie });
  await person('per_t2', 5, { firstName: 'Tie', lastName: 'Two', fullName: 'Tie Two', createdAt: tie, updatedAt: tie });
  await person('per_gone', 6, { firstName: 'Gone', fullName: 'Gone', deletedAt: at(7) });

  const conv = (id: string, n: number, extra: Partial<typeof schema.helpdeskConversations.$inferInsert>) => ({
    id,
    conversationNumber: `CONV-P${n}`,
    customerName: 'Customer',
    subject: `Conversation ${n}`,
    createdAt: at(n),
    updatedAt: at(n),
    ...extra,
  });
  await db.insert(schema.helpdeskConversations).values([
    conv('pc_1', 1, { contactId: 'per_a' }),
    conv('pc_2', 2, { contactId: 'per_a' }),
    conv('pc_3', 3, { contactId: 'per_a', deletedAt: at(9) }),
    conv('pc_4', 4, { contactId: 'per_c' }),
  ]);
}, 60_000);

describe(`${BASE} · list`, () => {
  it('lists live contacts by last update, the id breaking a tie, with the conversation count', async () => {
    const res = await app('conversations:read').request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(ids(body)).toEqual(['per_t2', 'per_t1', 'per_c', 'per_b', 'per_a']);
    expect(body.pagination).toEqual({ totalCount: 5, hasMore: false, cursor: null });
    // Always 0 on TypeScript: in a single-table select Drizzle renders the
    // subquery's `${t.id}` unqualified, so `hc.contact_id = "id"` compares a
    // conversation with itself instead of with the person.
    const counts = Object.fromEntries(body.data.map((r) => [r.id, r.conversationCount]));
    expect(counts).toEqual({ per_t2: 0, per_t1: 0, per_c: 0, per_b: 0, per_a: 0 });
    const cleo = body.data.find((r) => r.id === 'per_c')!;
    expect(Object.keys(cleo).sort()).toEqual(
      [
        'avatarUrl',
        'conversationCount',
        'createdAt',
        'directPhone',
        'email',
        'firstName',
        'fullName',
        'id',
        'interests',
        'lastContactedAt',
        'lastName',
        'mobilePhone',
        'notes',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('pages with a cursor through the tie', async () => {
    const { request } = app('conversations:read');
    const first = (await (await request(`${BASE}?limit=1`)).json()) as ListBody;
    expect(ids(first)).toEqual(['per_t2']);
    expect(first.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'per_t2' });
    const second = (await (await request(`${BASE}?limit=2&cursor=per_t2`)).json()) as ListBody;
    expect(ids(second)).toEqual(['per_t1', 'per_c']);
    expect(second.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'per_c' });
  });

  it('filters on status and search (first, last, full name, email)', async () => {
    const { request } = app('conversations:read');
    expect(ids((await (await request(`${BASE}?status=inactive`)).json()) as ListBody)).toEqual(['per_b']);
    expect(ids((await (await request(`${BASE}?search=Archer`)).json()) as ListBody)).toEqual(['per_a']);
    expect(ids((await (await request(`${BASE}?search=needle`)).json()) as ListBody)).toEqual(['per_c']);
    expect(ids((await (await request(`${BASE}?search=Tie%20T`)).json()) as ListBody)).toEqual(['per_t2']);
    // `like` is case-sensitive.
    expect(ids((await (await request(`${BASE}?search=archer`)).json()) as ListBody)).toEqual([]);
  });

  it('an unknown cursor is ignored, and the count then drops the last filter instead', async () => {
    const body = (await (await app('conversations:read').request(`${BASE}?status=inactive&cursor=per_missing`)).json()) as ListBody;
    expect(ids(body)).toEqual(['per_b']);
    expect(body.pagination.totalCount).toBe(5);
  });

  it('limit=0, 500 and abc', async () => {
    const { request } = app('conversations:read');
    const zero = (await (await request(`${BASE}?limit=0`)).json()) as ListBody;
    expect(zero.data).toEqual([]);
    expect(zero.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: null });
    expect(ids((await (await request(`${BASE}?limit=500`)).json()) as ListBody)).toHaveLength(5);
    expect(ids((await (await request(`${BASE}?limit=abc`)).json()) as ListBody)).toHaveLength(5);
  });

  it('needs conversations:read', async () => {
    expect((await app('contacts:read').request(BASE)).status).toBe(403);
  });
});

describe(`${BASE} · search and detail`, () => {
  it('GET /search matches names and email, newest update first, without deleted contacts', async () => {
    // No tie-breaker in this order, so the matches have distinct update times.
    const res = await app('conversations:read').request(`${BASE}/search?q=.test`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row[] };
    expect(data.map((r) => r.id)).toEqual(['per_c', 'per_b', 'per_a']);
    const byName = (await (await app('conversations:read').request(`${BASE}/search?q=Bak`)).json()) as { data: Row[] };
    expect(byName.data.map((r) => r.id)).toEqual(['per_b']);
    expect(Object.keys(data[0]!).sort()).toEqual(
      ['avatarUrl', 'directPhone', 'email', 'firstName', 'fullName', 'id', 'lastName', 'mobilePhone', 'status'].sort(),
    );
  });

  it('GET /search without q, or with an empty q, answers []', async () => {
    const { request } = app('conversations:read');
    for (const path of [`${BASE}/search`, `${BASE}/search?q=`]) {
      const res = await request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    }
    const none = (await (await request(`${BASE}/search?q=zzz`)).json()) as { data: Row[] };
    expect(none.data).toEqual([]);
  });

  it('GET /search needs conversations:read', async () => {
    expect((await app().request(`${BASE}/search?q=a`)).status).toBe(403);
  });

  it('GET /:id answers the whole people row, 404 when missing or deleted', async () => {
    const { request } = app('conversations:read');
    const res = await request(`${BASE}/per_c`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row };
    expect(data.id).toBe('per_c');
    expect(data.displayName).toBe('Person 3');
    expect(data.interests).toEqual(['billing']);
    expect((await request(`${BASE}/per_missing`)).status).toBe(404);
    expect((await request(`${BASE}/per_gone`)).status).toBe(404);
    expect((await app().request(`${BASE}/per_c`)).status).toBe(403);
  });
});

describe(`${BASE} · create`, () => {
  it('POST / with a valid body is the route 500: people.display_name is NOT NULL and the route never sets it', async () => {
    const { request } = app('conversations:create');
    for (const body of [
      { name: 'Mary Jane Watson', email: 'mj@x.test', phone: '+1 555', tags: ['press'], metadata: { a: 1 } },
      { name: 'Solo', email: 'solo@x.test', firstName: 'S', lastName: 'Olo', directPhone: '1', notes: 'n', status: 'lead' },
    ]) {
      const res = await request(BASE, json(body));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create helpdesk contact' },
      });
    }
    const rows = await db.select().from(schema.people).where(eq(schema.people.email, 'mj@x.test'));
    expect(rows).toEqual([]);
  });

  it('POST / refuses an invalid body', async () => {
    const { request } = app('conversations:create');
    for (const body of [
      { email: 'a@x.test' },
      { name: '', email: 'a@x.test' },
      { name: 'x'.repeat(256), email: 'a@x.test' },
      { name: 'A' },
      { name: 'A', email: 'nope' },
      { name: 'A', email: 'a@x.test', tags: 'vip' },
      { name: 'A', email: 'a@x.test', metadata: ['x'] },
      { name: 'A', email: 'a@x.test', status: 3 },
    ]) {
      expect((await request(BASE, json(body))).status).toBe(400);
    }
  });

  it('POST / needs conversations:create', async () => {
    expect((await app('conversations:read').request(BASE, json({ name: 'A', email: 'a@x.test' }))).status).toBe(403);
  });
});

describe(`${BASE} · update`, () => {
  it('PATCH recomputes fullName from the given half and the stored other half', async () => {
    const { request } = app('conversations:update');
    const res = await request(`${BASE}/per_a`, json({ firstName: 'Annie' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'per_a' } });
    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, 'per_a'));
    expect(row?.firstName).toBe('Annie');
    expect(row?.lastName).toBe('Archer');
    expect(row?.fullName).toBe('Annie Archer');
  });

  it('PATCH with a missing last name trims the full name', async () => {
    const res = await app('conversations:update').request(`${BASE}/per_c`, json({ firstName: 'Cleopatra' }, 'PATCH'));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, 'per_c'));
    expect(row?.fullName).toBe('Cleopatra');
  });

  it('PATCH with empty halves leaves an empty full name', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/per_b`,
      json({ firstName: '', lastName: '' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, 'per_b'));
    expect(row?.fullName).toBe('');
  });

  it('PATCH maps phone to directPhone and leaves fullName alone without a name', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/per_t1`,
      json({ phone: '+31 6 1', email: 'tie@x.test', notes: 'n', avatarUrl: 'https://x/t.png', unknown: 1 }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, 'per_t1'));
    expect(row?.directPhone).toBe('+31 6 1');
    expect(row?.email).toBe('tie@x.test');
    expect(row?.notes).toBe('n');
    expect(row?.avatarUrl).toBe('https://x/t.png');
    expect(row?.fullName).toBe('Tie One');
  });

  it('PATCH with an empty body only touches updatedAt', async () => {
    expect((await app('conversations:update').request(`${BASE}/per_t2`, json({}, 'PATCH'))).status).toBe(200);
  });

  it('PATCH refuses an invalid body, 404 when missing or deleted, 403 without the permission', async () => {
    const { request } = app('conversations:update');
    expect((await request(`${BASE}/per_a`, json({ email: 'nope' }, 'PATCH'))).status).toBe(400);
    expect((await request(`${BASE}/per_a`, json({ firstName: 5 }, 'PATCH'))).status).toBe(400);
    expect((await request(`${BASE}/per_missing`, json({ notes: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await request(`${BASE}/per_gone`, json({ notes: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await app('conversations:read').request(`${BASE}/per_a`, json({ notes: 'x' }, 'PATCH'))).status).toBe(403);
  });
});
