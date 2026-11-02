/**
 * Every /api/articles route on pglite: the list (filters, keyset paging, the
 * odd limits), detail, create (slug, content aliases, excerpt, author and
 * folder resolution), update (publish lifecycle, folder reassignment) and soft
 * delete, with their refusals. Runs against Rust in conformance mode
 * (rust/conformance/suites.json), so every seed has a fixed id and time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { articlesRoutes } from './index';

const BASE = '/api/articles';
const t = schema.helpdeskArticles;

type Row = Record<string, unknown>;
interface ListBody {
  data: Row[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, articlesRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

async function seedArticle(id: string, createdAt: Date, overrides: Row = {}): Promise<void> {
  await db.insert(t).values({
    id,
    title: `Article ${id}`,
    slug: id,
    content: 'Seed content',
    authorId: 'user_a',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as never);
}

async function row(id: string) {
  const [found] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  return found;
}

async function list(query = '', ...keys: string[]): Promise<ListBody> {
  const res = await app(...(keys.length ? keys : ['articles:read'])).request(`${BASE}${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

const ids = (body: ListBody) => body.data.map((r) => r.id);

async function create(body: Row): Promise<string> {
  const res = await app('articles:create').request(BASE, json(body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.helpdeskArticleFolders).values([
    { id: 'afld_guides', name: 'Guides', path: 'help/guides', createdAt: at(0), updatedAt: at(0) },
    { id: 'afld_loose', name: 'Loose ends', createdAt: at(0), updatedAt: at(0) },
  ]);
  await seedArticle('art_s01', at(1), {
    title: 'Getting started',
    status: 'published',
    visibility: 'public',
    categoryId: 'afld_guides',
  });
  await seedArticle('art_s02', at(2), { title: 'Billing FAQ', status: 'draft', visibility: 'internal', authorId: 'user_b' });
  await seedArticle('art_s03', at(3), { title: 'Needle in a haystack', status: 'review' });
  await seedArticle('art_s04', at(4), { title: 'Archived thing', status: 'archived', authorId: 'user_b' });
  await seedArticle('art_s05', at(5), { title: 'Deleted Needle', deletedAt: at(6) });
  // Two rows sharing a creation time: the id breaks the tie.
  const tie = new Date(Date.UTC(2026, 0, 2));
  await seedArticle('art_s06', tie, { authorId: 'user_b' });
  await seedArticle('art_s07', tie, { authorId: 'user_b' });
}, 60_000);

describe('GET /api/articles', () => {
  it('lists live rows newest first (id breaks a tie), with the count', async () => {
    const body = await list();
    expect(ids(body)).toEqual(['art_s07', 'art_s06', 'art_s04', 'art_s03', 'art_s02', 'art_s01']);
    expect(body.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
    expect(body.data[5]).toMatchObject({ title: 'Getting started', categoryId: 'afld_guides', deletedAt: null });
  });

  it('pages with limit and cursor; the count ignores the cursor', async () => {
    const first = await list('?limit=2');
    expect(ids(first)).toEqual(['art_s07', 'art_s06']);
    expect(first.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'art_s06' });
    const second = await list('?limit=2&cursor=art_s06');
    expect(ids(second)).toEqual(['art_s04', 'art_s03']);
    expect(second.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'art_s03' });
    const last = await list('?limit=2&cursor=art_s03');
    expect(ids(last)).toEqual(['art_s02', 'art_s01']);
    expect(last.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
  });

  it('an unknown cursor is ignored, but the count still drops the last condition', async () => {
    // The count leaves out the last condition whenever a cursor is given, on the
    // assumption that it is the cursor's. With an unknown cursor there is none,
    // so the last filter goes instead: here `deleted_at IS NULL`.
    const unknown = await list('?cursor=nope_missing');
    expect(ids(unknown)).toHaveLength(6);
    expect(unknown.pagination.totalCount).toBe(7);
    // ... and here the author filter (6 live rows, not user_b's 4).
    const filtered = await list('?authorId=user_b&cursor=nope_missing');
    expect(ids(filtered)).toHaveLength(4);
    expect(filtered.pagination.totalCount).toBe(6);
  });

  it('a deleted row still works as a cursor', async () => {
    const deleted = await list('?cursor=art_s05');
    expect(ids(deleted)).toEqual(['art_s04', 'art_s03', 'art_s02', 'art_s01']);
    expect(deleted.pagination.totalCount).toBe(6);
  });

  it('filters by status, visibility, folder, author and title search', async () => {
    expect(ids(await list('?status=published'))).toEqual(['art_s01']);
    expect(ids(await list('?visibility=internal'))).toEqual(['art_s02']);
    expect(ids(await list('?folderId=afld_guides'))).toEqual(['art_s01']);
    const byAuthor = await list('?authorId=user_b');
    expect(ids(byAuthor)).toEqual(['art_s07', 'art_s06', 'art_s04', 'art_s02']);
    expect(byAuthor.pagination.totalCount).toBe(4);
    // LIKE, so the match is case-sensitive, and deleted rows stay out.
    expect(ids(await list('?search=Needle'))).toEqual(['art_s03']);
    expect(ids(await list('?search=needle'))).toEqual([]);
    expect(ids(await list('?status=published&authorId=user_b'))).toEqual([]);
  });

  it('limit=0 reads one row and answers none, with hasMore', async () => {
    const body = await list('?limit=0');
    expect(body.data).toEqual([]);
    expect(body.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: null });
  });

  it('a limit above 100 is capped; one that is not a number has no LIMIT', async () => {
    expect(ids(await list('?limit=500'))).toHaveLength(6);
    const nan = await list('?limit=abc');
    expect(ids(nan)).toHaveLength(6);
    expect(nan.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
  });

  it('negative limits: -1 is LIMIT 0, -3 has no LIMIT and drops the last three rows', async () => {
    // `hasMore` is `rows.length > limit`, so any count beats a negative limit.
    const minusOne = await list('?limit=-1');
    expect(minusOne.data).toEqual([]);
    expect(minusOne.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: null });
    const minusThree = await list('?limit=-3');
    expect(ids(minusThree)).toEqual(['art_s07', 'art_s06', 'art_s04']);
    expect(minusThree.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'art_s04' });
  });

  it('needs articles:read', async () => {
    expect((await app().request(BASE)).status).toBe(403);
    expect((await app('articles:create').request(BASE)).status).toBe(403);
  });
});

describe('GET /api/articles/:id', () => {
  it('answers the row', async () => {
    const res = await app('articles:read').request(`${BASE}/art_s01`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row };
    expect(data).toMatchObject({
      id: 'art_s01',
      title: 'Getting started',
      slug: 'art_s01',
      content: 'Seed content',
      status: 'published',
      visibility: 'public',
      categoryId: 'afld_guides',
      authorId: 'user_a',
      isDraft: true,
      version: 1,
      viewCount: 0,
      isPinned: false,
      allowComments: true,
    });
  });

  it('404 when missing or deleted, 403 without the permission', async () => {
    const { request } = app('articles:read');
    const missing = await request(`${BASE}/nope_missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Article with ID 'nope_missing' not found" },
    });
    expect((await request(`${BASE}/art_s05`)).status).toBe(404);
    expect((await app().request(`${BASE}/art_s01`)).status).toBe(403);
  });
});

describe('POST /api/articles', () => {
  it('derives the slug from the title, takes `body` as content, and defaults the rest', async () => {
    const id = await create({ title: 'How to start using WeldSuite', body: 'Sign up, pick a plan, go!' });
    expect(id).toMatch(/^art_/);
    const created = await row(id);
    expect(created).toMatchObject({
      title: 'How to start using WeldSuite',
      // Every slug gets `-<six characters of the id>` appended.
      slug: `how-to-start-using-weldsuite-${id.slice(4, 10)}`,
      content: 'Sign up, pick a plan, go!',
      excerpt: 'Sign up, pick a plan, go!',
      status: 'draft',
      visibility: 'public',
      isDraft: true,
      publishedAt: null,
      authorId: 'user_test_default',
      authorName: null,
      categoryId: null,
      category: null,
      categoryName: null,
      viewCount: 0,
      helpfulCount: 0,
      notHelpfulCount: 0,
      tags: null,
    });
  });

  it('slugifies an explicit slug; one that slugifies to nothing falls back to the id', async () => {
    const custom = await create({ title: 'Anything', slug: '  Custom Article Slug!! ', content: 'Explicit content' });
    expect((await row(custom))?.slug).toBe(`custom-article-slug-${custom.slice(4, 10)}`);
    const symbols = await create({ title: '!!!', slug: '***' });
    expect((await row(symbols))?.slug).toBe(`${symbols}-${symbols.slice(4, 10)}`);
    // An empty slug is the same as none: the title's slug.
    const empty = await create({ title: 'From the title', slug: '' });
    expect((await row(empty))?.slug).toBe(`from-the-title-${empty.slice(4, 10)}`);
  });

  it('content beats body beats bodyHtml; an empty one is skipped', async () => {
    const all = await create({ title: 'C1', content: 'canonical', body: 'alias', bodyHtml: '<p>html</p>' });
    expect((await row(all))?.content).toBe('canonical');
    const emptyContent = await create({ title: 'C2', content: '', body: 'alias', bodyHtml: '<p>html</p>' });
    expect((await row(emptyContent))?.content).toBe('alias');
    const html = await create({ title: 'C3', bodyHtml: '<p>Hello <b>world</b></p>' });
    expect(await row(html)).toMatchObject({ content: '<p>Hello <b>world</b></p>', excerpt: 'Hello world' });
    const none = await create({ title: 'C4' });
    expect(await row(none)).toMatchObject({ content: '', excerpt: '' });
  });

  it('the excerpt is the given one, else the first 200 characters of the text', async () => {
    const long = 'x'.repeat(250);
    const derived = await create({ title: 'E1', content: `<div>${long}</div>` });
    expect((await row(derived))?.excerpt).toBe('x'.repeat(200));
    const given = await create({ title: 'E2', content: 'Body', excerpt: 'Short summary' });
    expect((await row(given))?.excerpt).toBe('Short summary');
    const emptyGiven = await create({ title: 'E3', content: 'Body', excerpt: '' });
    expect((await row(emptyGiven))?.excerpt).toBe('');
  });

  it('a published article is stamped; author, visibility and tags come from the body', async () => {
    const id = await create({
      title: 'Published one',
      content: 'Live',
      status: 'published',
      visibility: 'internal',
      authorId: 'user_writer',
      authorName: 'Writer',
      tags: ['setup', 'billing'],
    });
    const created = await row(id);
    expect(created).toMatchObject({
      status: 'published',
      visibility: 'internal',
      isDraft: false,
      authorId: 'user_writer',
      authorName: 'Writer',
      tags: ['setup', 'billing'],
    });
    expect(created?.publishedAt).toBeInstanceOf(Date);
    // An empty or null author is the caller.
    expect((await row(await create({ title: 'A1', authorId: '' })))?.authorId).toBe('user_test_default');
    expect((await row(await create({ title: 'A2', authorId: null })))?.authorId).toBe('user_test_default');
    // Other statuses stay drafts.
    expect(await row(await create({ title: 'R1', status: 'review' }))).toMatchObject({
      status: 'review',
      isDraft: true,
      publishedAt: null,
    });
  });

  it('resolves the folder: its name and path (or name) are copied onto the article', async () => {
    const withPath = await create({ title: 'F1', folderId: 'afld_guides' });
    expect(await row(withPath)).toMatchObject({
      categoryId: 'afld_guides',
      categoryName: 'Guides',
      category: 'help/guides',
    });
    const noPath = await create({ title: 'F2', categoryId: 'afld_loose' });
    expect(await row(noPath)).toMatchObject({
      categoryId: 'afld_loose',
      categoryName: 'Loose ends',
      category: 'Loose ends',
    });
    // folderId wins over categoryId, even when it is null.
    const both = await create({ title: 'F3', folderId: 'afld_loose', categoryId: 'afld_guides' });
    expect((await row(both))?.categoryId).toBe('afld_loose');
    const nullFolder = await create({ title: 'F4', folderId: null, categoryId: 'afld_guides' });
    expect(await row(nullFolder)).toMatchObject({ categoryId: null, categoryName: null, category: null });
    const emptyFolder = await create({ title: 'F5', folderId: '' });
    expect((await row(emptyFolder))?.categoryId).toBeNull();
  });

  it('an unknown folder breaks the foreign key: the route 500', async () => {
    const res = await app('articles:create').request(BASE, json({ title: 'F6', folderId: 'afld_missing' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create article' } });
  });

  it('passthrough keys are accepted but never stored, columns included', async () => {
    const id = await create({ title: 'P1', isPinned: true, metaTitle: 'Meta', notAColumn: 'x', metadata: { a: 1 } });
    expect(await row(id)).toMatchObject({ isPinned: false, metaTitle: null });
  });

  it('refuses an invalid body', async () => {
    const { request } = app('articles:create');
    const invalid: Row[] = [
      {},
      { title: '' },
      { title: 'x'.repeat(501) },
      { title: 'x', slug: 'x'.repeat(501) },
      { title: 'x', status: 'live' },
      { title: 'x', visibility: 'private' },
      { title: 'x', tags: [1] },
      { title: 'x', authorName: 'x'.repeat(256) },
      { title: 'x', content: 5 },
      { title: 'x', folderId: 7 },
    ];
    for (const body of invalid) {
      expect((await request(BASE, json(body))).status).toBe(400);
    }
    const malformed = await request(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"oops',
    });
    expect(malformed.status).toBe(400);
  });

  it('needs articles:create', async () => {
    expect((await app('articles:read').request(BASE, json({ title: 'No' }))).status).toBe(403);
  });
});

describe('PATCH /api/articles/:id', () => {
  it('updates the scalar fields as given (the slug is not slugified)', async () => {
    await seedArticle('art_p01', at(30));
    const res = await app('articles:update').request(
      `${BASE}/art_p01`,
      json(
        {
          title: 'Renamed',
          slug: 'Raw Slug!',
          excerpt: 'New excerpt',
          visibility: 'internal',
          tags: ['a'],
          authorName: 'Editor',
          authorId: 'user_ignored',
          isPinned: true,
        },
        'PATCH',
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'art_p01' } });
    expect(await row('art_p01')).toMatchObject({
      title: 'Renamed',
      slug: 'Raw Slug!',
      excerpt: 'New excerpt',
      visibility: 'internal',
      tags: ['a'],
      authorName: 'Editor',
      // Not in the update list: untouched.
      authorId: 'user_a',
      isPinned: false,
    });
  });

  it('takes content from its aliases, leaves it when none is given', async () => {
    await seedArticle('art_p02', at(31));
    const { request } = app('articles:update');
    await request(`${BASE}/art_p02`, json({ bodyHtml: '<p>html</p>' }, 'PATCH'));
    expect((await row('art_p02'))?.content).toBe('<p>html</p>');
    await request(`${BASE}/art_p02`, json({ content: '', body: 'from body' }, 'PATCH'));
    expect((await row('art_p02'))?.content).toBe('from body');
    await request(`${BASE}/art_p02`, json({ title: 'Only title' }, 'PATCH'));
    expect((await row('art_p02'))?.content).toBe('from body');
    // An empty body, or a timestamp the route does not read, only bumps updatedAt.
    expect((await request(`${BASE}/art_p02`, json({}, 'PATCH'))).status).toBe(200);
    expect((await request(`${BASE}/art_p02`, json({ updatedAt: '2026-01-01T00:00:00.000Z' }, 'PATCH'))).status).toBe(
      200,
    );
  });

  it('reassigns and clears the folder', async () => {
    await seedArticle('art_p03', at(32));
    const { request } = app('articles:update');
    await request(`${BASE}/art_p03`, json({ folderId: 'afld_guides' }, 'PATCH'));
    expect(await row('art_p03')).toMatchObject({ categoryId: 'afld_guides', categoryName: 'Guides', category: 'help/guides' });
    await request(`${BASE}/art_p03`, json({ categoryId: 'afld_loose' }, 'PATCH'));
    expect(await row('art_p03')).toMatchObject({ categoryId: 'afld_loose', category: 'Loose ends' });
    await request(`${BASE}/art_p03`, json({ folderId: null }, 'PATCH'));
    expect(await row('art_p03')).toMatchObject({ categoryId: null, categoryName: null, category: null });
    const unknown = await request(`${BASE}/art_p03`, json({ folderId: 'afld_missing' }, 'PATCH'));
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update article' } });
  });

  it('runs the publish lifecycle across the published boundary', async () => {
    await seedArticle('art_p04', at(33), { status: 'draft', isDraft: true });
    const { request } = app('articles:update');

    await request(`${BASE}/art_p04`, json({ status: 'published' }, 'PATCH'));
    const published = await row('art_p04');
    expect(published).toMatchObject({ status: 'published', isDraft: false, unpublishedAt: null });
    expect(published?.publishedAt).toBeInstanceOf(Date);

    // Same status: nothing about publishing changes.
    await request(`${BASE}/art_p04`, json({ status: 'published', title: 'Still live' }, 'PATCH'));
    expect(await row('art_p04')).toMatchObject({ status: 'published', isDraft: false, title: 'Still live' });

    await request(`${BASE}/art_p04`, json({ status: 'archived' }, 'PATCH'));
    const archived = await row('art_p04');
    expect(archived).toMatchObject({ status: 'archived', isDraft: true });
    expect(archived?.unpublishedAt).toBeInstanceOf(Date);
    // The first publication date stays.
    expect(archived?.publishedAt).toBeInstanceOf(Date);

    // Between two unpublished statuses only the status moves.
    await request(`${BASE}/art_p04`, json({ status: 'review' }, 'PATCH'));
    const review = await row('art_p04');
    expect(review).toMatchObject({ status: 'review', isDraft: true });
    expect(review?.unpublishedAt).toBeInstanceOf(Date);

    // Republishing clears unpublishedAt.
    await request(`${BASE}/art_p04`, json({ status: 'published' }, 'PATCH'));
    expect(await row('art_p04')).toMatchObject({ status: 'published', isDraft: false, unpublishedAt: null });
  });

  it('404 when missing or deleted, 400 when invalid, 403 without the permission', async () => {
    const { request } = app('articles:update');
    const missing = await request(`${BASE}/nope_missing`, json({ title: 'x' }, 'PATCH'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Article with ID 'nope_missing' not found" },
    });
    expect((await request(`${BASE}/art_s05`, json({ title: 'x' }, 'PATCH'))).status).toBe(404);
    for (const body of [{ status: 'nope' }, { title: '' }, { visibility: 'private' }, { tags: 'a' }]) {
      expect((await request(`${BASE}/art_s01`, json(body, 'PATCH'))).status).toBe(400);
    }
    expect((await app('articles:read').request(`${BASE}/art_s01`, json({ title: 'x' }, 'PATCH'))).status).toBe(403);
  });
});

describe('DELETE /api/articles/:id', () => {
  it('soft-deletes; a deleted row is gone', async () => {
    await seedArticle('art_d01', at(40));
    const { request } = app('articles:delete', 'articles:read');
    const res = await request(`${BASE}/art_d01`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await row('art_d01'))?.deletedAt).toBeInstanceOf(Date);
    const again = await request(`${BASE}/art_d01`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Article with ID 'art_d01' not found" } });
    expect((await request(`${BASE}/art_d01`)).status).toBe(404);
  });

  it('needs articles:delete', async () => {
    expect((await app('articles:read').request(`${BASE}/art_s02`, { method: 'DELETE' })).status).toBe(403);
  });
});
