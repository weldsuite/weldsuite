/**
 * Every /api/canned-responses route on pglite: the shared CRUD suite
 * (../../test/crud-suite.ts) for list/detail/create/update/delete, plus the
 * picker search (scope visibility, ranking), the category list and
 * `POST /:id/use` (`{{variable}}` rendering, the usage bump). Runs against
 * Rust in conformance mode.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { cannedResponsesRoutes } from './index';

const BASE = '/api/canned-responses';
const t = schema.helpdeskCannedResponses;

describeCrud(BASE, {
  base: BASE,
  routes: cannedResponsesRoutes,
  table: t,
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  // Another agent's personal responses: listed by GET /, never found by /search.
  seed: (n) => ({ name: `Canned ${n}`, content: `Body ${n}`, scope: 'personal', agentId: 'user_crud' }),
  // The schema wants `body`, the column is `content`: only a passthrough `content` stores.
  valid: {
    name: 'Greeting',
    body: 'alias only',
    content: 'Hello {{customer.name}}',
    subject: 'Hi',
    shortcut: '/hi',
    category: 'General',
    departmentId: null,
    isShared: true,
  },
  unstorable: { name: 'No content', body: 'only the alias' },
  invalid: [
    {},
    { body: 'x' },
    { name: '', body: 'x' },
    { name: 'x' },
    { name: 'x', body: 5 },
    { name: 'x', body: 'x', shortcut: 'x'.repeat(51) },
    { name: 'x', body: 'x', category: 'x'.repeat(101) },
    { name: 'x', body: 'x', subject: 'x'.repeat(501) },
    { name: 'x', body: 'x', isShared: 'yes' },
    { name: 'x', body: 'x', departmentId: 3 },
  ],
  patch: { name: 'Greeting 2', subject: 'Hello there', category: 'General' },
  invalidPatch: { isShared: 'no' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle canned' } },
    { query: 'search=Haystack', match: { subject: 'In the Haystack' } },
    { query: 'departmentId=dep_filter', match: { departmentId: 'dep_filter' } },
    { query: 'category=Crud', match: { category: 'Crud' } },
  ],
});

const TEMPLATE =
  'Hi {{customer.name}}, order {{ order.id }} ({{order.missing}}) {{customer.name.first}} {{customer}} ' +
  '[{{tags}}] {{count}} {{flag}} {{nil}} {{ }} {{}} {{{customer.name}}} {{price}} {{ unknown.path }}';

describe('/api/canned-responses · search, categories and use', () => {
  // createPgliteDb() is one database per file: the CRUD suite's rows (personal
  // to `user_crud`, or personal with no agent) are here too, invisible to /search.
  let db: Database;
  const app = (keys: string[], userId?: string) =>
    createTestApp(BASE, cannedResponsesRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db, ...(userId ? { userId } : {}) },
    });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const at = (second: number) => new Date(Date.UTC(2026, 0, 4, 12, 0, second));
  const row = async (id: string) => (await db.select().from(t).where(eq(t.id, id)).limit(1))[0];

  async function search(query: string, userId?: string): Promise<string[]> {
    const res = await app(['tickets:read'], userId).request(`${BASE}/search${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
  }

  async function use(id: string, body: unknown) {
    const res = await app(['tickets:read']).request(`${BASE}/${id}/use`, json(body));
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { content: string; subject: string | null; actions: unknown[] } }).data;
  }

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    const seed = (id: string, second: number, values: Record<string, unknown>) => ({
      id,
      content: 'Seed content',
      scope: 'global',
      usageCount: 0,
      createdAt: at(second),
      updatedAt: at(second),
      ...values,
    });
    await db.insert(t).values([
      seed('cr_mine', 1, {
        name: 'Refund policy',
        content: 'We refund within 30 days',
        shortcut: '/refund',
        scope: 'personal',
        agentId: 'user_test_default',
        usageCount: 5,
        category: 'Billing',
      }),
      seed('cr_other', 2, { name: 'Refund (other agent)', scope: 'personal', agentId: 'user_other', usageCount: 50 }),
      seed('cr_team', 3, {
        name: 'Shipping times',
        content: 'Ships in {{days}} days',
        shortcut: '/ship',
        scope: 'team',
        usageCount: 10,
        category: 'shipping',
      }),
      seed('cr_dept', 4, { name: 'Zebra accounts', content: 'Account help', scope: 'department', category: 'accounts' }),
      seed('cr_global_a', 5, { name: 'Alpha hello', content: 'Hello', category: 'accounts' }),
      seed('cr_null_usage', 6, { name: 'Null usage', usageCount: null }),
      seed('cr_inactive', 7, { name: 'Refund old', isActive: false, category: 'inactive-cat' }),
      seed('cr_deleted', 8, { name: 'Refund deleted', category: 'Deleted', deletedAt: at(9) }),
      seed('cr_emptycat', 10, { name: 'Empty category', category: '' }),
      seed('cr_vars', 11, {
        name: 'Template vars',
        content: TEMPLATE,
        subject: 'Re: order {{order.id}} for {{ customer.name }}',
        actions: [{ type: 'set_status', value: 'pending' }],
        usageCount: null,
      }),
    ] as never);
  }, 60_000);

  describe('GET /search', () => {
    it('lists every visible active response: most used first (NULL counts first), then by name', async () => {
      const expected = [
        'cr_null_usage',
        'cr_vars',
        'cr_team',
        'cr_mine',
        'cr_global_a',
        'cr_emptycat',
        'cr_dept',
      ];
      expect(await search('')).toEqual(expected);
      expect(await search('?q=')).toEqual(expected);
    });

    it('answers the full rows', async () => {
      const res = await app(['tickets:read']).request(`${BASE}/search?q=policy`);
      const { data } = (await res.json()) as { data: unknown[] };
      expect(data).toEqual([
        expect.objectContaining({
          id: 'cr_mine',
          name: 'Refund policy',
          scope: 'personal',
          agentId: 'user_test_default',
          usageCount: 5,
          isActive: true,
          deletedAt: null,
        }),
      ]);
    });

    it('matches name, content or shortcut, case-insensitively, the term trimmed', async () => {
      // Others' personal, inactive and deleted rows stay out.
      expect(await search('?q=refund')).toEqual(['cr_mine']);
      expect(await search('?q=%20%20REFUND%20%20')).toEqual(['cr_mine']);
      expect(await search('?q=30%20days')).toEqual(['cr_mine']);
      expect(await search('?q=%2Fship')).toEqual(['cr_team']);
      expect(await search('?q=nothing-matches-this')).toEqual([]);
    });

    it('another agent sees their own personal responses, not mine', async () => {
      expect(await search('?q=refund', 'user_other')).toEqual(['cr_other']);
    });

    it('limit caps the rows', async () => {
      expect(await search('?limit=2')).toEqual(['cr_null_usage', 'cr_vars']);
      expect(await search('?limit=50')).toHaveLength(7);
    });

    it('refuses a limit out of 1..50 or not a number, and a term over 200 characters', async () => {
      const { request } = app(['tickets:read']);
      for (const query of ['limit=0', 'limit=51', 'limit=abc', `q=${'x'.repeat(201)}`]) {
        expect((await request(`${BASE}/search?${query}`)).status).toBe(400);
      }
    });

    it('needs tickets:read', async () => {
      expect((await app([]).request(`${BASE}/search`)).status).toBe(403);
    });
  });

  describe('GET /categories', () => {
    it('lists the distinct categories of rows not deleted, inactive ones included, sorted with localeCompare', async () => {
      const res = await app(['tickets:read']).request(`${BASE}/categories`);
      expect(res.status).toBe(200);
      // 'Crud' and 'General' come from the CRUD suite's rows. localeCompare, not
      // byte order: 'accounts' sorts before 'Billing'.
      expect(await res.json()).toEqual({
        data: ['', 'accounts', 'Billing', 'Crud', 'General', 'inactive-cat', 'shipping'],
      });
    });

    it('needs tickets:read', async () => {
      expect((await app(['tickets:create']).request(`${BASE}/categories`)).status).toBe(403);
    });
  });

  describe('GET /:id', () => {
    it('answers any live row, personal ones of others included; 404 names the response', async () => {
      const { request } = app(['tickets:read']);
      const res = await request(`${BASE}/cr_other`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown }).data).toMatchObject({ id: 'cr_other', agentId: 'user_other' });
      const deleted = await request(`${BASE}/cr_deleted`);
      expect(deleted.status).toBe(404);
      expect(await deleted.json()).toEqual({
        error: { code: 'NOT_FOUND', message: "Canned response with ID 'cr_deleted' not found" },
      });
    });
  });

  describe('GET /', () => {
    it('an empty departmentId or category is no filter', async () => {
      const { request } = app(['tickets:read']);
      const total = async (query: string) =>
        ((await (await request(`${BASE}${query}`)).json()) as { pagination: { totalCount: number } }).pagination
          .totalCount;
      const all = await total('');
      expect(await total('?departmentId=')).toBe(all);
      expect(await total('?category=')).toBe(all);
      expect(await total('?category=accounts')).toBe(2);
    });
  });

  describe('POST /:id/use', () => {
    it('renders {{variables}} by dot path; unresolvable ones stay as written', async () => {
      const data = await use('cr_vars', {
        variables: {
          customer: { name: 'Ada', tier: 'gold' },
          order: { id: 42 },
          tags: ['a', null, 'b'],
          count: 0,
          flag: false,
          nil: null,
          price: 12.5,
        },
      });
      expect(data).toEqual({
        content:
          'Hi Ada, order 42 ({{order.missing}}) {{customer.name.first}} {"name":"Ada","tier":"gold"} ' +
          '[a,,b] 0 false {{nil}} {{ }} {{}} {Ada} 12.5 {{ unknown.path }}',
        subject: 'Re: order 42 for Ada',
        actions: [{ type: 'set_status', value: 'pending' }],
      });
    });

    it('bumps the usage count (from NULL too) and stamps lastUsedAt', async () => {
      const before = await row('cr_vars');
      expect(before?.lastUsedAt).toBeInstanceOf(Date);
      expect(before?.usageCount).toBe(1);
      await use('cr_vars', {});
      expect((await row('cr_vars'))?.usageCount).toBe(2);
    });

    it('without variables nothing resolves', async () => {
      const data = await use('cr_vars', {});
      expect(data.content).toBe(TEMPLATE);
      expect(data.subject).toBe('Re: order {{order.id}} for {{ customer.name }}');
      expect(await use('cr_vars', { variables: {} })).toEqual(data);
    });

    it('a response without subject or actions answers null and []', async () => {
      expect(await use('cr_dept', { variables: { days: 3 } })).toEqual({
        content: 'Account help',
        subject: null,
        actions: [],
      });
      expect((await use('cr_team', { variables: { days: 3 } })).content).toBe('Ships in 3 days');
    });

    it('a request without a JSON body renders with no variables', async () => {
      const res = await app(['tickets:read']).request(`${BASE}/cr_team/use`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { content: string } }).data.content).toBe('Ships in {{days}} days');
    });

    it('refuses variables that are not an object', async () => {
      const { request } = app(['tickets:read']);
      for (const body of [{ variables: 'x' }, { variables: [1, 2] }, { variables: null }, { variables: 3 }]) {
        expect((await request(`${BASE}/cr_vars/use`, json(body))).status).toBe(400);
      }
      const malformed = await request(`${BASE}/cr_vars/use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"oops',
      });
      expect(malformed.status).toBe(400);
    });

    it('404 when missing or deleted, 403 without tickets:read', async () => {
      const { request } = app(['tickets:read']);
      const missing = await request(`${BASE}/nope_missing/use`, json({}));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { code: 'NOT_FOUND', message: "Canned response with ID 'nope_missing' not found" },
      });
      expect((await request(`${BASE}/cr_deleted/use`, json({}))).status).toBe(404);
      expect((await app(['tickets:update']).request(`${BASE}/cr_vars/use`, json({}))).status).toBe(403);
    });
  });
});
