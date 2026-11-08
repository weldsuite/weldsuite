/**
 * Every /api/helpdesk-announcements route on pglite, through the shared CRUD
 * suite (../../test/crud-suite.ts), plus what the writes decide themselves:
 * the author is the caller, publishing stamps `publishedAt`, and only the
 * schema's columns are written. Runs against Rust in conformance mode.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskAnnouncementsRoutes } from './index';

const BASE = '/api/helpdesk-announcements';
const t = schema.helpdeskAnnouncements;

describeCrud('/api/helpdesk-announcements', {
  base: BASE,
  routes: helpdeskAnnouncementsRoutes,
  table: t,
  gates: { read: 'articles:read', create: 'articles:create', update: 'articles:update', delete: 'articles:delete' },
  seed: (n) => ({ title: `Announcement ${n}`, content: 'Body', authorId: 'user_a' }),
  valid: {
    title: 'Maintenance',
    content: 'Tonight from 22:00',
    type: 'warning',
    visibility: 'specific_groups',
    targetGroups: ['comp_a'],
    expiresAt: '2030-01-01T00:00:00Z',
  },
  invalid: [
    { title: '' },
    { title: 'No content' },
    { title: 'x', content: 'c', type: 'urgent' },
    { title: 'x', content: 'c', status: 'live' },
    { title: 'x', content: 'c', visibility: 'everyone' },
    { title: 'x', content: 'c', targetGroups: 'comp_a' },
    { title: 'x', content: 'c', publishedAt: 'tomorrow' },
    { title: 'x', content: 'c', isPinned: 'yes' },
  ],
  patch: { title: 'Maintenance moved', status: 'published' },
  invalidPatch: { title: 7 },
  filters: [{ query: 'search=Needle', match: { title: 'Needle notice' } }],
  strictBody: true,
});

describe('/api/helpdesk-announcements · writes', () => {
  let db: Database;
  const app = (...keys: string[]) =>
    createTestApp(BASE, helpdeskAnnouncementsRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db, userId: 'user_author' },
    });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const row = async (id: string) => (await db.select().from(t).where(eq(t.id, id)).limit(1))[0]!;
  const create = async (body: Record<string, unknown>) => {
    const res = await app('articles:create').request(BASE, json(body));
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 60_000);

  it('takes the author from the caller and ignores keys that are not columns', async () => {
    const id = await create({ title: 'Hello', content: 'World', authorId: 'someone_else', body: 'ignored', audience: 'all' });
    const stored = await row(id);
    expect(stored.authorId).toBe('user_author');
    expect(stored).toMatchObject({ title: 'Hello', content: 'World', status: 'draft', type: 'info', visibility: 'public' });
    expect(stored.publishedAt).toBeNull();
  });

  it('stamps publishedAt when created published without one, keeps a given one', async () => {
    const now = await create({ title: 'Live', content: 'Now', status: 'published', authorName: 'Ann' });
    expect((await row(now)).publishedAt).toBeInstanceOf(Date);
    const given = await create({ title: 'Later', content: 'Soon', status: 'published', publishedAt: '2031-05-01T08:30:00Z', isPinned: true });
    const stored = await row(given);
    expect(stored.publishedAt?.toISOString()).toBe('2031-05-01T08:30:00.000Z');
    expect(stored.isPinned).toBe(true);
  });

  it('stamps publishedAt on the first publish only', async () => {
    const id = await create({ title: 'Draft', content: 'Soon' });
    const res = await app('articles:update').request(`${BASE}/${id}`, json({ status: 'published', expiresAt: '2032-01-01T00:00:00Z' }, 'PATCH'));
    expect(res.status).toBe(200);
    const first = await row(id);
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.expiresAt?.toISOString()).toBe('2032-01-01T00:00:00.000Z');

    await app('articles:update').request(`${BASE}/${id}`, json({ status: 'archived' }, 'PATCH'));
    await app('articles:update').request(`${BASE}/${id}`, json({ status: 'published', targetGroups: null, excerpt: null }, 'PATCH'));
    expect((await row(id)).publishedAt?.getTime()).toBe(first.publishedAt?.getTime());

    const cleared = await app('articles:update').request(`${BASE}/${id}`, json({ publishedAt: null, expiresAt: null }, 'PATCH'));
    expect(cleared.status).toBe(200);
    expect((await row(id)).publishedAt).toBeNull();
  });
});

it('exports the router the suite mounts', () => {
  expect(helpdeskAnnouncementsRoutes.routes.length).toBeGreaterThan(0);
});
