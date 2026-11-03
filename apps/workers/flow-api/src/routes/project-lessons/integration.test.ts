/**
 * DB-backed integration tests for lessons learned: /api/project-lessons.
 * Runs against the TypeScript worker and, in conformance mode
 * (rust/conformance/suites.json), the Rust backend, so every status code,
 * message and event payload asserted here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectLessonsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_les_manager';
const MEMBER = 'user_les_member';
const OTHER_MEMBER = 'user_les_member2';
const VIEWER = 'user_les_viewer';
const OUTSIDER = 'user_les_outsider';
const SCOPE_ALL = 'user_les_scope_all';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete', 'knowledge:create'];
const MEMBER_KEYS = ['projects:read', 'projects:create', 'projects:update', 'knowledge:create'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = FULL): Send {
  const { request } = createTestApp('/api/project-lessons', projectLessonsRoutes, {
    context: {
      userId,
      permissions: permissions(...keys, ...(userId === SCOPE_ALL ? ['projects:scope:all'] : [])),
      tenantDb: db,
    },
  });
  return (method, path, body) =>
    request(`/api/project-lessons${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const manager = () => as(MANAGER);
const member = () => as(MEMBER, MEMBER_KEYS);

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

type Lesson = {
  id: string;
  projectId: string;
  category: string;
  text: string;
  authorId: string;
  voteCount: number;
  votedByMe: boolean;
  knowPageId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

const published = vi.mocked(publishEntityEvent);
const events = () =>
  published.mock.calls.map(([event]) => ({
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data as Record<string, unknown>,
  }));
const actions = () => events().map((event) => `${event.entityType}.${event.action}`);

/** The id a create answered, as its events carry it: in conformance mode only the prefix is the same. */
const minted = (id: string) => (conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id);

beforeEach(() => {
  published.mockClear();
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

async function seedProject(id: string, name = id) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name, projectManagerId: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values(
    [
      [MEMBER, 'member'],
      [OTHER_MEMBER, 'member'],
      [VIEWER, 'viewer'],
    ].map(([userId, role]) => ({ id: `pm_${id}_${userId}`, projectId: id, userId, role, isActive: true, createdAt: now, updatedAt: now, joinedAt: now })),
  );
}

async function addLesson(projectId: string, body: Record<string, unknown> = {}, who: Send = manager()): Promise<Lesson> {
  const res = await who('POST', '', { projectId, category: 'went_well', text: 'The rehearsal caught two data problems', ...body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return data<Lesson>(res);
}

async function seedSpace(id: string, options: { visibility?: 'open' | 'private'; editors?: string[] } = {}) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.knowledgeSpaces).values({
    id,
    name: id,
    kind: 'team',
    visibility: options.visibility ?? 'open',
    createdAt: now,
    updatedAt: now,
  });
  for (const userId of options.editors ?? []) {
    await db.insert(schema.knowledgeSpaceMembers).values({ id: `${id}_${userId}`, spaceId: id, userId, role: 'editor', createdAt: now, updatedAt: now });
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

describe('POST /', () => {
  it('adds a lesson with the caller as its author, no votes and no page', async () => {
    await seedProject('prj_les_create');
    const created = await addLesson('prj_les_create', { text: '  Splitting the release kept go-live  ', category: 'do_differently' }, member());
    expect(created).toMatchObject({
      projectId: 'prj_les_create',
      category: 'do_differently',
      text: 'Splitting the release kept go-live',
      authorId: MEMBER,
      createdBy: MEMBER,
      voteCount: 0,
      votedByMe: false,
      knowPageId: null,
    });
    expect(created.id).toMatch(/^les_/);
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
  });

  it('publishes created with ids and counts, and no text', async () => {
    await seedProject('prj_les_event');
    const created = await addLesson('prj_les_event');
    expect(events()).toEqual([
      {
        entityType: 'project_lesson',
        action: 'created',
        entityId: minted(created.id),
        data: {
          id: minted(created.id),
          projectId: 'prj_les_event',
          category: 'went_well',
          authorId: MANAGER,
          voteCount: 0,
          knowPageId: null,
        },
      },
    ]);
  });

  it('rejects what does not fit', async () => {
    await seedProject('prj_les_bad');
    const bad = async (body: unknown) => manager()('POST', '', body);
    const base = { projectId: 'prj_les_bad', category: 'went_well', text: 'ok' };

    for (const body of [
      { ...base, text: '   ' },
      { ...base, text: 'x'.repeat(2001) },
      { ...base, category: 'meh' },
      { ...base, id: 'les_hijack' },
      { ...base, authorId: 'user_other' },
      { category: 'went_well', text: 'No project' },
      { projectId: 'prj_les_bad', text: 'No category' },
      'not an object',
    ]) {
      const res = await bad(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    expect(actions()).toEqual([]);
  });

  it('refuses viewers, outsiders and callers without the permission, and answers 404 for a missing project', async () => {
    await seedProject('prj_les_access');
    const body = { projectId: 'prj_les_access', category: 'went_well', text: 'ok' };

    const viewer = await as(VIEWER, MEMBER_KEYS)('POST', '', body);
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER, MEMBER_KEYS)('POST', '', body)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', '', body)).status).toBe(403);

    const unknown = await as(SCOPE_ALL)('POST', '', { ...body, projectId: 'prj_les_nowhere' });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toBe("Project with ID 'prj_les_nowhere' not found");
    expect(actions()).toEqual([]);
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('GET', () => {
  beforeAll(async () => {
    await seedProject('prj_les_list');
    await seedProject('prj_les_list_b');
    await addLesson('prj_les_list', { category: 'went_well', text: 'Portal sign-off worked well' });
    await addLesson('prj_les_list', { category: 'went_badly', text: 'Load testing started late' });
    await addLesson('prj_les_list', { category: 'went_badly', text: 'Brand assets arrived late' });
    await addLesson('prj_les_list', { category: 'do_differently', text: 'Start the trial migration in month one' });
    await addLesson('prj_les_list_b', { category: 'went_well', text: 'Other project lesson' });
  });

  const texts = async (query: string, who: Send = manager()) => {
    const res = await who('GET', `?${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Lesson[] }).data.map((lesson) => lesson.text).sort();
  };

  it('lists one project, filtered by category and search', async () => {
    expect(await texts('projectId=prj_les_list')).toEqual([
      'Brand assets arrived late',
      'Load testing started late',
      'Portal sign-off worked well',
      'Start the trial migration in month one',
    ]);
    expect(await texts('projectId=prj_les_list&category=went_badly')).toEqual(['Brand assets arrived late', 'Load testing started late']);
    expect(await texts('projectId=prj_les_list&search=LATE')).toEqual(['Brand assets arrived late', 'Load testing started late']);
    // % and _ are text, not wildcards.
    expect(await texts('projectId=prj_les_list&search=%25')).toEqual([]);
  });

  it('pages with a cursor, newest first', async () => {
    const first = (await (await manager()('GET', '?projectId=prj_les_list&limit=3')).json()) as {
      data: Lesson[];
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(first.data).toHaveLength(3);
    expect(first.pagination).toMatchObject({ totalCount: 4, hasMore: true });
    const second = (await (await manager()('GET', `?projectId=prj_les_list&limit=3&cursor=${first.pagination.cursor}`)).json()) as typeof first;
    expect(second.data).toHaveLength(1);
    expect(second.pagination).toMatchObject({ hasMore: false, cursor: null });
    expect(new Set([...first.data, ...second.data].map((lesson) => lesson.id)).size).toBe(4);
    expect(first.data[0]!.text).toBe('Start the trial migration in month one');
  });

  it('without a project, covers the projects the caller is in', async () => {
    expect(await texts('category=went_well')).toContain('Other project lesson');
    expect(await texts('category=went_well', as(OUTSIDER))).toEqual([]);
    expect(await texts('projectId=prj_les_list&category=went_well', as(VIEWER))).toEqual(['Portal sign-off worked well']);
  });

  it('refuses a project the caller is not in, bad filters and a missing permission', async () => {
    const outsider = await as(OUTSIDER)('GET', '?projectId=prj_les_list');
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
    const category = await manager()('GET', '?category=meh');
    expect(category.status).toBe(400);
    expect((await errorOf(category)).message).toBe('Invalid query parameters');
    expect((await as(MANAGER, ['tasks:create'])('GET', '')).status).toBe(403);
  });

  it('answers one lesson, with whether the caller voted', async () => {
    const created = await addLesson('prj_les_list', { text: 'Voted lesson' });
    expect((await member()('POST', `/${created.id}/vote`)).status).toBe(200);
    const mine = await data<Lesson>(await member()('GET', `/${created.id}`));
    expect(mine).toMatchObject({ id: created.id, voteCount: 1, votedByMe: true });
    const theirs = await data<Lesson>(await manager()('GET', `/${created.id}`));
    expect(theirs).toMatchObject({ voteCount: 1, votedByMe: false });
  });

  it('answers 404 for a missing lesson and 403 for a project the caller is not in', async () => {
    const created = await addLesson('prj_les_list', { text: 'Private to the project' });
    const missing = await manager()('GET', '/les_nowhere');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toBe("Lesson with ID 'les_nowhere' not found");
    const outsider = await as(OUTSIDER)('GET', `/${created.id}`);
    expect(outsider.status).toBe(403);
    expect((await errorOf(outsider)).message).toBe('You are not a member of this project');
  });
});

// ── Edit and delete ─────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  it('lets the author edit the text and the category', async () => {
    await seedProject('prj_les_edit');
    const created = await addLesson('prj_les_edit', {}, member());
    published.mockClear();
    const res = await member()('PATCH', `/${created.id}`, { text: 'Better text', category: 'went_badly' });
    expect(res.status).toBe(200);
    expect(await data<Lesson>(res)).toMatchObject({ id: created.id, text: 'Better text', category: 'went_badly', authorId: MEMBER });
    expect(events()).toEqual([
      {
        entityType: 'project_lesson',
        action: 'updated',
        entityId: minted(created.id),
        data: { id: minted(created.id), projectId: 'prj_les_edit', category: 'went_badly', authorId: MEMBER, voteCount: 0, knowPageId: null },
      },
    ]);
  });

  it("lets a project manager edit someone else's lesson, and nobody else", async () => {
    await seedProject('prj_les_edit2');
    const created = await addLesson('prj_les_edit2', {}, member());
    expect((await manager()('PATCH', `/${created.id}`, { text: 'Edited by the manager' })).status).toBe(200);

    const other = await as(OTHER_MEMBER, MEMBER_KEYS)('PATCH', `/${created.id}`, { text: 'Not yours' });
    expect(other.status).toBe(403);
    expect((await errorOf(other)).message).toBe('Only the author of a lesson or a project manager can change it');
    expect(await data<Lesson>(await manager()('GET', `/${created.id}`))).toMatchObject({ text: 'Edited by the manager' });
  });

  it('keeps the order of checks: the lesson, access, then the body, then the author', async () => {
    await seedProject('prj_les_edit3');
    const created = await addLesson('prj_les_edit3', {}, member());
    expect((await manager()('PATCH', '/les_nowhere', { text: 'x' })).status).toBe(404);
    expect((await as(OUTSIDER)('PATCH', `/${created.id}`, { text: 'x' })).status).toBe(403);
    const viewer = await as(VIEWER, MEMBER_KEYS)('PATCH', `/${created.id}`, { text: 'x' });
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    // A bad body is a 400 before the author rule.
    const bad = await as(OTHER_MEMBER, MEMBER_KEYS)('PATCH', `/${created.id}`, { text: '' });
    expect(bad.status).toBe(400);
    expect((await manager()('PATCH', `/${created.id}`, { category: 'meh' })).status).toBe(400);
    expect((await manager()('PATCH', `/${created.id}`, { projectId: 'prj_other' })).status).toBe(400);
    expect((await as(MANAGER, ['projects:read'])('PATCH', `/${created.id}`, { text: 'x' })).status).toBe(403);
  });
});

describe('DELETE /:id', () => {
  it('soft deletes for the author and for a manager, and publishes deleted', async () => {
    await seedProject('prj_les_delete');
    const author = as(MEMBER, [...MEMBER_KEYS, 'projects:delete']);
    const mine = await addLesson('prj_les_delete', {}, author);
    const theirs = await addLesson('prj_les_delete', { text: 'Another lesson' }, author);
    published.mockClear();

    const res = await author('DELETE', `/${mine.id}`);
    expect(res.status).toBe(204);
    expect(events()).toEqual([
      {
        entityType: 'project_lesson',
        action: 'deleted',
        entityId: minted(mine.id),
        data: { id: minted(mine.id), projectId: 'prj_les_delete', category: 'went_well' },
      },
    ]);
    expect((await manager()('GET', `/${mine.id}`)).status).toBe(404);
    expect((await manager()('DELETE', `/${mine.id}`)).status).toBe(404);

    expect((await manager()('DELETE', `/${theirs.id}`)).status).toBe(204);
    const [row] = await db.select().from(schema.projectLessons).where(eq(schema.projectLessons.projectId, 'prj_les_delete')).limit(1);
    expect(row?.deletedAt).not.toBeNull();
    const left = await data<Lesson[]>(await manager()('GET', '?projectId=prj_les_delete'));
    expect(left).toEqual([]);
  });

  it('refuses another member, viewers, outsiders and a missing permission', async () => {
    await seedProject('prj_les_delete2');
    const created = await addLesson('prj_les_delete2', {}, member());
    const other = await as(OTHER_MEMBER, [...MEMBER_KEYS, 'projects:delete'])('DELETE', `/${created.id}`);
    expect(other.status).toBe(403);
    expect((await errorOf(other)).message).toBe('Only the author of a lesson or a project manager can change it');
    expect((await as(VIEWER, [...MEMBER_KEYS, 'projects:delete'])('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await as(OUTSIDER)('DELETE', `/${created.id}`)).status).toBe(403);
    // Without projects:delete the author cannot either.
    expect((await member()('DELETE', `/${created.id}`)).status).toBe(403);
    expect((await manager()('GET', `/${created.id}`)).status).toBe(200);
  });
});

// ── Votes ───────────────────────────────────────────────────────────────────

describe('votes', () => {
  it('votes once, and takes the vote back', async () => {
    await seedProject('prj_les_vote');
    const created = await addLesson('prj_les_vote');
    published.mockClear();

    const voted = await member()('POST', `/${created.id}/vote`);
    expect(voted.status).toBe(200);
    expect(await data<Lesson>(voted)).toMatchObject({ voteCount: 1, votedByMe: true });
    expect(events()).toEqual([
      {
        entityType: 'project_lesson',
        action: 'updated',
        entityId: minted(created.id),
        data: { id: minted(created.id), projectId: 'prj_les_vote', category: 'went_well', authorId: MANAGER, voteCount: 1, knowPageId: null },
      },
    ]);

    // Voting again changes nothing and publishes nothing.
    published.mockClear();
    expect(await data<Lesson>(await member()('POST', `/${created.id}/vote`))).toMatchObject({ voteCount: 1, votedByMe: true });
    expect(actions()).toEqual([]);

    const taken = await member()('DELETE', `/${created.id}/vote`);
    expect(taken.status).toBe(200);
    expect(await data<Lesson>(taken)).toMatchObject({ voteCount: 0, votedByMe: false });
    expect(actions()).toEqual(['project_lesson.updated']);

    // Taking back a vote that is not there changes nothing either.
    published.mockClear();
    expect(await data<Lesson>(await member()('DELETE', `/${created.id}/vote`))).toMatchObject({ voteCount: 0 });
    expect(actions()).toEqual([]);
  });

  it('keeps every vote when several come at once', async () => {
    await seedProject('prj_les_race');
    const created = await addLesson('prj_les_race');
    const voters = [manager(), member(), as(OTHER_MEMBER, MEMBER_KEYS), as(SCOPE_ALL)];
    const results = await Promise.all(voters.map((send) => send('POST', `/${created.id}/vote`)));
    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(await data<Lesson>(await manager()('GET', `/${created.id}`))).toMatchObject({ voteCount: 4 });
  });

  it('lets only people with write access vote', async () => {
    await seedProject('prj_les_vote2');
    const created = await addLesson('prj_les_vote2');
    const viewer = await as(VIEWER, MEMBER_KEYS)('POST', `/${created.id}/vote`);
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER, MEMBER_KEYS)('POST', `/${created.id}/vote`)).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('POST', `/${created.id}/vote`)).status).toBe(403);
    expect((await manager()('POST', '/les_nowhere/vote')).status).toBe(404);
    expect((await manager()('DELETE', '/les_nowhere/vote')).status).toBe(404);
    expect(await data<Lesson>(await manager()('GET', `/${created.id}`))).toMatchObject({ voteCount: 0 });
  });
});

// ── Publish to WeldKnow ─────────────────────────────────────────────────────

describe('POST /publish', () => {
  async function pageOf(id: string) {
    const [page] = await db.select().from(schema.knowledgePages).where(eq(schema.knowledgePages.id, id)).limit(1);
    return page;
  }
  const lines = (blocks: unknown) =>
    (blocks as Array<{ type: string; content: Array<{ text: string }> }>).map((block) => `${block.type}:${block.content[0]?.text}`);

  it('creates one page with the lessons grouped by category, most votes first, and points every lesson at it', async () => {
    await seedProject('prj_les_pub', 'Customer Portal');
    await seedSpace('kspc_les_open', { editors: [MANAGER] });
    const slow = await addLesson('prj_les_pub', { category: 'went_badly', text: 'Load testing started late' });
    const well = await addLesson('prj_les_pub', { category: 'went_well', text: 'Portal sign-off' });
    const better = await addLesson('prj_les_pub', { category: 'went_well', text: 'Weekly reports' });
    const trial = await addLesson('prj_les_pub', { category: 'do_differently', text: 'Trial migration in month one' });
    const deleted = await addLesson('prj_les_pub', { category: 'went_well', text: 'Deleted before publishing' });
    expect((await manager()('DELETE', `/${deleted.id}`)).status).toBe(204);
    await member()('POST', `/${better.id}/vote`);
    await as(OTHER_MEMBER, MEMBER_KEYS)('POST', `/${better.id}/vote`);
    await member()('POST', `/${slow.id}/vote`);
    published.mockClear();

    const res = await manager()('POST', '/publish', { projectId: 'prj_les_pub', spaceId: 'kspc_les_open' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const result = await data<{ pageId: string; spaceId: string; title: string; lessonCount: number }>(res);
    expect(result).toMatchObject({ spaceId: 'kspc_les_open', title: 'Lessons learned: Customer Portal', lessonCount: 4 });

    const page = await pageOf(result.pageId);
    expect(page).toMatchObject({ spaceId: 'kspc_les_open', parentId: null, position: 0, title: 'Lessons learned: Customer Portal', createdBy: MANAGER });
    expect(lines(page?.contentJson)).toEqual([
      'heading:Went well',
      'bulletListItem:Weekly reports (2 votes)',
      'bulletListItem:Portal sign-off',
      "heading:Didn't go well",
      'bulletListItem:Load testing started late (1 vote)',
      'heading:Do differently',
      'bulletListItem:Trial migration in month one',
    ]);
    expect(page?.contentText).toContain('Weekly reports (2 votes)');

    const lessons = await data<Lesson[]>(await manager()('GET', '?projectId=prj_les_pub'));
    expect(lessons).toHaveLength(4);
    expect(lessons.every((lesson) => lesson.knowPageId === result.pageId)).toBe(true);

    // The page's event, then one published per lesson, oldest first.
    expect(actions()).toEqual([
      'knowledge_page.created',
      'project_lesson.published',
      'project_lesson.published',
      'project_lesson.published',
      'project_lesson.published',
    ]);
    expect(events()[0]).toMatchObject({
      entityType: 'knowledge_page',
      data: { id: minted(result.pageId), spaceId: 'kspc_les_open', parentId: null, title: 'Lessons learned: Customer Portal' },
    });
    expect(events().slice(1).map((event) => event.entityId)).toEqual([slow.id, well.id, better.id, trial.id].map(minted));
    expect(events()[1]!.data).toMatchObject({ projectId: 'prj_les_pub', category: 'went_badly', knowPageId: minted(result.pageId) });
  });

  it('writes the page in Dutch and names it as asked', async () => {
    await seedProject('prj_les_nl', 'Klantportaal');
    await seedSpace('kspc_les_nl', { editors: [MANAGER] });
    await addLesson('prj_les_nl', { category: 'went_badly', text: 'Te laat gestart' });
    const res = await manager()('POST', '/publish', { projectId: 'prj_les_nl', spaceId: 'kspc_les_nl', locale: 'nl', title: 'Retrospective' });
    expect(res.status).toBe(201);
    const result = await data<{ pageId: string; title: string }>(res);
    expect(result.title).toBe('Retrospective');
    expect(lines((await pageOf(result.pageId))?.contentJson)).toEqual(['heading:Ging niet goed', 'bulletListItem:Te laat gestart']);

    await seedProject('prj_les_nl2', 'Klantportaal');
    await addLesson('prj_les_nl2', { text: 'Goed gedaan' });
    const defaulted = await manager()('POST', '/publish', { projectId: 'prj_les_nl2', spaceId: 'kspc_les_nl', locale: 'nl' });
    expect((await data<{ title: string }>(defaulted)).title).toBe('Geleerde lessen: Klantportaal');
  });

  it('puts a second publish on a new page of the same space, after the first', async () => {
    await seedProject('prj_les_twice');
    await seedSpace('kspc_les_twice', { editors: [MANAGER] });
    await addLesson('prj_les_twice');
    const first = await data<{ pageId: string }>(await manager()('POST', '/publish', { projectId: 'prj_les_twice', spaceId: 'kspc_les_twice' }));
    await addLesson('prj_les_twice', { text: 'Added after the first publish' });
    const second = await data<{ pageId: string; lessonCount: number }>(await manager()('POST', '/publish', { projectId: 'prj_les_twice', spaceId: 'kspc_les_twice' }));
    expect(second.pageId).not.toBe(first.pageId);
    expect(second.lessonCount).toBe(2);
    expect((await pageOf(second.pageId))?.position).toBe(1);
    const lessons = await data<Lesson[]>(await manager()('GET', '?projectId=prj_les_twice'));
    expect(lessons.every((lesson) => lesson.knowPageId === second.pageId)).toBe(true);
  });

  it('refuses a project without lessons and a body that does not fit', async () => {
    await seedProject('prj_les_none');
    await seedSpace('kspc_les_none', { editors: [MANAGER] });
    const none = await manager()('POST', '/publish', { projectId: 'prj_les_none', spaceId: 'kspc_les_none' });
    expect(none.status).toBe(400);
    expect((await errorOf(none)).message).toBe('There are no lessons to publish');

    for (const body of [{ projectId: 'prj_les_none' }, { spaceId: 'kspc_les_none' }, { projectId: 'prj_les_none', spaceId: 'kspc_les_none', locale: 'fr' }, { projectId: 'prj_les_none', spaceId: 'kspc_les_none', title: '' }]) {
      const res = await manager()('POST', '/publish', body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
    expect(actions()).toEqual([]);
  });

  it('answers as the teamspace rules do: 404 for a space the caller cannot see, 403 without the editor role', async () => {
    await seedProject('prj_les_space');
    await seedSpace('kspc_les_private', { visibility: 'private', editors: [OTHER_MEMBER] });
    await seedSpace('kspc_les_readonly');
    await addLesson('prj_les_space');
    published.mockClear();

    const hidden = await manager()('POST', '/publish', { projectId: 'prj_les_space', spaceId: 'kspc_les_private' });
    expect(hidden.status).toBe(404);
    expect((await errorOf(hidden)).message).toBe("Space with ID 'kspc_les_private' not found");
    const missing = await manager()('POST', '/publish', { projectId: 'prj_les_space', spaceId: 'kspc_nowhere' });
    expect(missing.status).toBe(404);

    const notEditor = await manager()('POST', '/publish', { projectId: 'prj_les_space', spaceId: 'kspc_les_readonly' });
    expect(notEditor.status).toBe(403);
    expect((await errorOf(notEditor)).message).toBe('This needs the editor role in the teamspace.');
    expect(actions()).toEqual([]);
    const lessons = await data<Lesson[]>(await manager()('GET', '?projectId=prj_les_space'));
    expect(lessons.every((lesson) => lesson.knowPageId === null)).toBe(true);
    const pages = await db.select().from(schema.knowledgePages).where(and(eq(schema.knowledgePages.spaceId, 'kspc_les_readonly')));
    expect(pages).toEqual([]);
  });

  it('needs write access to the project, the project, and the permissions', async () => {
    await seedProject('prj_les_perm');
    await seedSpace('kspc_les_perm', { editors: [MANAGER, MEMBER, VIEWER, OUTSIDER] });
    await addLesson('prj_les_perm');
    const body = { projectId: 'prj_les_perm', spaceId: 'kspc_les_perm' };

    const viewer = await as(VIEWER, MEMBER_KEYS)('POST', '/publish', body);
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).message).toBe('You do not have write access to this project');
    expect((await as(OUTSIDER, MEMBER_KEYS)('POST', '/publish', body)).status).toBe(403);
    // knowledge:create and projects:update are both needed.
    expect((await as(MEMBER, ['projects:read', 'projects:update'])('POST', '/publish', body)).status).toBe(403);
    expect((await as(MEMBER, ['projects:read', 'knowledge:create'])('POST', '/publish', body)).status).toBe(403);

    const unknown = await as(SCOPE_ALL)('POST', '/publish', { ...body, projectId: 'prj_les_nowhere' });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toBe("Project with ID 'prj_les_nowhere' not found");
    expect((await member()('POST', '/publish', body)).status).toBe(201);
  });
});
