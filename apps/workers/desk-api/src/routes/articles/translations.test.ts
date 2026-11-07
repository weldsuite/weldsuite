/**
 * /api/articles audiences and language versions on pglite: the new
 * visibilities with their company audience, an article's own locale, the
 * originals-only list, and `GET|POST /:id/translations` with the one version
 * per locale rule. Runs against Rust in conformance mode ("desk: knowledge
 * base"), so every seed has a fixed id and time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { articlesRoutes } from './index';

const BASE = '/api/articles';
const t = schema.helpdeskArticles;

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, articlesRoutes, { context: { permissions: permissions(...keys), tenantDb: db, userId: 'user_translator' } });

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));
const row = async (id: string) => (await db.select().from(t).where(eq(t.id, id)).limit(1))[0]!;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.helpdeskArticleFolders).values({ id: 'afld_t', name: 'Translated', path: 'help/translated', createdAt: at(0), updatedAt: at(0) });
  await db.insert(t).values([
    {
      id: 'art_orig',
      title: 'Getting started',
      slug: 'getting-started',
      content: '<p>Welcome</p>',
      excerpt: 'Welcome',
      authorId: 'user_a',
      status: 'published',
      visibility: 'groups',
      audienceCompanyIds: ['comp_a'],
      categoryId: 'afld_t',
      categoryName: 'Translated',
      category: 'help/translated',
      tags: ['start'],
      locale: 'en',
      createdAt: at(1),
      updatedAt: at(1),
    },
    { id: 'art_nl', title: 'Aan de slag', slug: 'aan-de-slag', content: '<p>Welkom</p>', authorId: 'user_a', locale: 'nl', translationOfId: 'art_orig', createdAt: at(2), updatedAt: at(2) },
    { id: 'art_de_gone', title: 'Erste Schritte', slug: 'erste', content: 'x', authorId: 'user_a', locale: 'de', translationOfId: 'art_orig', deletedAt: at(3), createdAt: at(3), updatedAt: at(3) },
    { id: 'art_plain', title: 'Plain', slug: 'plain', content: 'x', authorId: 'user_a', createdAt: at(4), updatedAt: at(4) },
  ]);
}, 60_000);

describe('audiences and locale on writes', () => {
  it('stores the new visibilities, the audience and a lower-cased locale', async () => {
    const res = await app('articles:create').request(
      BASE,
      json({ title: 'Partners only', content: '<p>Hi</p>', visibility: 'groups', audienceCompanyIds: ['comp_a', 'comp_b'], locale: 'PT-br' }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    expect(await row(id)).toMatchObject({ visibility: 'groups', audienceCompanyIds: ['comp_a', 'comp_b'], locale: 'pt-br', translationOfId: null });

    const signedIn = await app('articles:create').request(BASE, json({ title: 'Members', visibility: 'logged_in' }));
    const signedInId = ((await signedIn.json()) as { data: { id: string } }).data.id;
    expect(await row(signedInId)).toMatchObject({ visibility: 'logged_in', audienceCompanyIds: [], locale: null });

    const patched = await app('articles:update').request(`${BASE}/${signedInId}`, json({ visibility: 'groups', audienceCompanyIds: ['comp_c'], locale: 'fr' }, 'PATCH'));
    expect(patched.status).toBe(200);
    expect(await row(signedInId)).toMatchObject({ visibility: 'groups', audienceCompanyIds: ['comp_c'], locale: 'fr' });
    await app('articles:update').request(`${BASE}/${signedInId}`, json({ locale: null }, 'PATCH'));
    expect((await row(signedInId)).locale).toBeNull();
  });

  it('refuses an unknown visibility, a bad audience or a bad locale', async () => {
    const { request } = app('articles:create');
    for (const body of [
      { title: 'x', visibility: 'specific_users' },
      { title: 'x', visibility: 'private' },
      { title: 'x', audienceCompanyIds: 'comp_a' },
      { title: 'x', audienceCompanyIds: [''] },
      { title: 'x', audienceCompanyIds: ['x'.repeat(31)] },
      { title: 'x', locale: 'english' },
      { title: 'x', locale: 'e' },
      { title: 'x', locale: 'nl_NL' },
    ]) {
      expect((await request(BASE, json(body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('keeps one version per locale when a locale changes', async () => {
    const { request } = app('articles:update');
    // The original can't take a version's language, nor a version the original's or a sibling's.
    for (const [id, locale] of [['art_orig', 'nl'], ['art_nl', 'en'], ['art_nl', null]] as const) {
      const res = await request(`${BASE}/${id}`, json({ locale }, 'PATCH'));
      expect(res.status, `${id} ${locale}`).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
    }
    // A deleted version doesn't hold its language; the same locale is a no-op.
    expect((await request(`${BASE}/art_nl`, json({ locale: 'NL' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${BASE}/art_plain`, json({ locale: 'de' }, 'PATCH'))).status).toBe(200);
    await request(`${BASE}/art_plain`, json({ locale: null }, 'PATCH'));
  });
});

describe('GET /?originals=1', () => {
  it('lists only originals', async () => {
    const res = await app('articles:read').request(`${BASE}?originals=1&limit=100`);
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map((a) => a.id);
    expect(ids).toContain('art_orig');
    expect(ids).not.toContain('art_nl');
  });
});

describe('language versions', () => {
  it('lists the original first, then its live versions by locale, from any member of the family', async () => {
    for (const id of ['art_orig', 'art_nl']) {
      const res = await app('articles:read').request(`${BASE}/${id}/translations`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [
          { id: 'art_orig', title: 'Getting started', slug: 'getting-started', status: 'published', visibility: 'groups', locale: 'en', translationOfId: null, updatedAt: at(1).toISOString() },
          { id: 'art_nl', title: 'Aan de slag', slug: 'aan-de-slag', status: 'draft', visibility: 'public', locale: 'nl', translationOfId: 'art_orig', updatedAt: expect.any(String) },
        ],
      });
    }
    expect((await app('articles:read').request(`${BASE}/art_de_gone/translations`)).status).toBe(404);
    expect((await app('articles:read').request(`${BASE}/art_nope/translations`)).status).toBe(404);
    expect((await app().request(`${BASE}/art_orig/translations`)).status).toBe(403);
  });

  it('creates a draft version with the original’s audience and folder, its text by default', async () => {
    const res = await app('articles:create').request(`${BASE}/art_nl/translations`, json({ locale: 'FR' }));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    const version = await row(id);
    expect(version).toMatchObject({
      title: 'Getting started',
      content: '<p>Welcome</p>',
      excerpt: 'Welcome',
      status: 'draft',
      isDraft: true,
      publishedAt: null,
      visibility: 'groups',
      audienceCompanyIds: ['comp_a'],
      locale: 'fr',
      translationOfId: 'art_orig',
      categoryId: 'afld_t',
      categoryName: 'Translated',
      category: 'help/translated',
      tags: ['start'],
      authorId: 'user_translator',
    });
    expect(version.slug).toMatch(/^getting-started-/);

    const given = await app('articles:create').request(
      `${BASE}/art_orig/translations`,
      json({ locale: 'de', title: 'Erste Schritte', content: '<p>Willkommen</p>', excerpt: 'Willkommen' }),
    );
    expect(given.status).toBe(201);
    const de = await row(((await given.json()) as { data: { id: string } }).data.id);
    expect(de).toMatchObject({ title: 'Erste Schritte', content: '<p>Willkommen</p>', excerpt: 'Willkommen', locale: 'de' });
  });

  it('refuses a language the article already has, a bad body, a missing article and a caller without the permission', async () => {
    const { request } = app('articles:create');
    for (const locale of ['nl', 'EN', 'fr']) {
      const res = await request(`${BASE}/art_orig/translations`, json({ locale }));
      expect(res.status, locale).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'This article already has a version in that language' } });
    }
    for (const body of [{}, { locale: '' }, { locale: 'xx', title: '' }, { locale: 'xx', content: 5 }]) {
      expect((await request(`${BASE}/art_orig/translations`, json(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(`${BASE}/art_nope/translations`, json({ locale: 'it' }))).status).toBe(404);
    expect((await app('articles:read').request(`${BASE}/art_orig/translations`, json({ locale: 'it' }))).status).toBe(403);
  });
});
