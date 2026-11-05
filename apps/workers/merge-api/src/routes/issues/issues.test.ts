/**
 * DB-backed tests for /api/merge/issues (with comments and pull request links)
 * on a real tenant schema (pglite). What must not regress:
 *   1. Numbers come from the team's counter in the same statement as the insert:
 *      consecutive, per team, no duplicates under concurrent creates, and a
 *      refused create hands none out.
 *   2. `PLAT-209` finds the issue, in any case; so does its id.
 *   3. Status changes keep started/completed/canceled timestamps consistent.
 *   4. Cycle, labels and parent must belong to the issue's team; a parent is
 *      never the issue itself or one of its own sub-issues.
 *   5. Comments: anyone with update can write, only the author edits, the author
 *      or a holder of merge_issues:delete deletes.
 *   6. Every mutation publishes its entity event.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  MergeCommentDto,
  MergeIssueDetailDto,
  MergeIssueDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import issuesRoutes from './index';
import commentsRoutes from '../comments';
import {
  ADMIN,
  ALICE,
  BOB,
  MEMBER,
  VIEWER,
  clearEvents,
  errorCode,
  eventTypes,
  events,
  jsonInit,
  makeApp,
  newId,
  ok,
  openDb,
  resetTables,
} from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

const BASE = '/api/merge/issues';
const issues = (grants = ADMIN, userId = ALICE) => makeApp(db, BASE, issuesRoutes, { grants, userId });
const comments = (grants = ADMIN, userId = ALICE) => makeApp(db, '/api/merge/comments', commentsRoutes, { grants, userId });

async function newIssue(teamId: string, extra: Record<string, unknown> = {}) {
  return ok<MergeIssueDto>(await issues().request(BASE, jsonInit({ teamId, title: 'Fix the tabs', ...extra })), 201);
}

describe('create and number allocation', () => {
  it('creates an issue with the next number, the defaults, and publishes merge_issue:created', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id, { description: 'Tabs jump', priority: 2, labelIds: [] });
    expect(issue).toMatchObject({
      teamId: team.id,
      teamKey: 'PLAT',
      number: 1,
      key: 'PLAT-1',
      title: 'Fix the tabs',
      description: 'Tabs jump',
      status: 'backlog',
      priority: 2,
      assigneeUserId: null,
      creatorUserId: ALICE,
      pullRequestCount: 0,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    });
    expect(issue.id).toMatch(/^mis_/);
    expect(eventTypes()).toEqual(['merge_issue:created']);
    expect(events[0]!.data).toEqual({
      id: newId(issue.id),
      teamId: team.id,
      key: 'PLAT-1',
      title: 'Fix the tabs',
      status: 'backlog',
      priority: 2,
      assigneeUserId: null,
    });
  });

  it('numbers consecutively per team, and the counter follows', async () => {
    const plat = await seedTeam(db, 'PLAT');
    const api = await seedTeam(db, 'API');
    const numbers = [];
    for (const team of [plat, plat, api, plat]) numbers.push((await newIssue(team.id)).key);
    expect(numbers).toEqual(['PLAT-1', 'PLAT-2', 'API-1', 'PLAT-3']);
    const [row] = await db.select().from(schema.mergeTeams).where(eq(schema.mergeTeams.id, plat.id));
    expect(row!.issueCounter).toBe(3);
  });

  it('never hands out the same number twice under concurrent creates', async () => {
    const team = await seedTeam(db, 'PLAT');
    const created = await Promise.all(
      Array.from({ length: 8 }, () => issues().request(BASE, jsonInit({ teamId: team.id, title: 'Parallel' }))),
    );
    expect(created.map((r) => r.status)).toEqual(Array(8).fill(201));
    const numbers = (await Promise.all(created.map((r) => ok<MergeIssueDto>(r, 201)))).map((i) => i.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('starts timestamps from the first status: in_progress sets startedAt, done sets completedAt', async () => {
    const team = await seedTeam(db, 'PLAT');
    const running = await newIssue(team.id, { status: 'in_progress' });
    expect(running.startedAt).not.toBeNull();
    expect(running.completedAt).toBeNull();
    const done = await newIssue(team.id, { status: 'done' });
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
    const canceled = await newIssue(team.id, { status: 'canceled' });
    expect(canceled.startedAt).toBeNull();
    expect(canceled.canceledAt).not.toBeNull();
  });

  it('hands out no number when the create is refused', async () => {
    const team = await seedTeam(db, 'PLAT');
    const other = await seedTeam(db, 'API');
    const foreignCycle = await db
      .insert(schema.mergeCycles)
      .values({ id: 'mcy_other', teamId: other.id, number: 1, startsAt: '2026-11-01', endsAt: '2026-11-14' })
      .returning();
    expect(foreignCycle).toHaveLength(1);

    const res = await issues().request(BASE, jsonInit({ teamId: team.id, title: 'x', cycleId: 'mcy_other' }));
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.mergeTeams).where(eq(schema.mergeTeams.id, team.id));
    expect(row!.issueCounter).toBe(0);
    expect(events).toEqual([]);
    expect((await newIssue(team.id)).number).toBe(1);
  });

  it('refuses bad input (400), an unknown team (404) and a deleted team (404)', async () => {
    const team = await seedTeam(db, 'PLAT');
    const bad: Array<[unknown, string]> = [
      [{ title: 'x' }, 'no team'],
      [{ teamId: team.id }, 'no title'],
      [{ teamId: team.id, title: '   ' }, 'blank title'],
      [{ teamId: team.id, title: 'x', status: 'started' }, 'unknown status'],
      [{ teamId: team.id, title: 'x', priority: 5 }, 'priority out of range'],
      [{ teamId: team.id, title: 'x', dueDate: '5 Nov' }, 'bad date'],
      [{ teamId: team.id, title: 'x', estimate: -1 }, 'negative estimate'],
    ];
    for (const [body, why] of bad) expect((await issues().request(BASE, jsonInit(body))).status, why).toBe(400);
    expect((await issues().request(BASE, jsonInit({ teamId: 'mtm_unknown', title: 'x' }))).status).toBe(404);
    const gone = await seedTeam(db, 'GONE', { deletedAt: new Date() });
    expect((await issues().request(BASE, jsonInit({ teamId: gone.id, title: 'x' }))).status).toBe(404);
    expect(events).toEqual([]);
  });

  it('needs merge_issues:create', async () => {
    const team = await seedTeam(db, 'PLAT');
    expect((await issues(VIEWER).request(BASE, jsonInit({ teamId: team.id, title: 'x' }))).status).toBe(403);
    expect((await issues(MEMBER).request(BASE, jsonInit({ teamId: team.id, title: 'x' }))).status).toBe(201);
  });
});

describe('read', () => {
  it('finds an issue by id and by key in any case, with sub-issues and pull requests', async () => {
    const team = await seedTeam(db, 'PLAT');
    const parent = await newIssue(team.id, { title: 'Parent' });
    const child = await newIssue(team.id, { title: 'Child', parentIssueId: parent.id });
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const pr = await seedPullRequest(db, repo.id, 7, { title: 'PLAT-1 fix' });
    await db.insert(schema.mergeIssuePullRequests).values({ id: 'mip_1', issueId: parent.id, pullRequestId: pr.id, source: 'auto', closes: true });

    for (const ref of [parent.id, 'PLAT-1', 'plat-1']) {
      const detail = await ok<MergeIssueDetailDto>(await issues(VIEWER).request(`${BASE}/${ref}`));
      expect(detail).toMatchObject({ id: parent.id, key: 'PLAT-1', pullRequestCount: 1 });
      expect(detail.subIssues.map((s) => s.id)).toEqual([child.id]);
      expect(detail.pullRequests).toHaveLength(1);
      expect(detail.pullRequests[0]).toMatchObject({
        id: pr.id,
        number: 7,
        repositoryFullName: 'acme/web',
        link: { source: 'auto', closes: true },
      });
    }
    for (const ref of ['PLAT-99', 'API-1', 'mis_unknown']) {
      const res = await issues().request(`${BASE}/${ref}`);
      expect(res.status, ref).toBe(404);
      expect(await errorCode(res)).toBe('NOT_FOUND');
    }
  });

  it('does not find a deleted issue, and needs merge_issues:read', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id);
    await issues().request(`${BASE}/${issue.id}`, { method: 'DELETE' });
    expect((await issues().request(`${BASE}/PLAT-1`)).status).toBe(404);
    expect((await issues([]).request(`${BASE}/${issue.id}`)).status).toBe(403);
    expect((await issues([]).request(BASE)).status).toBe(403);
  });
});

describe('list', () => {
  async function seedList() {
    const plat = await seedTeam(db, 'PLAT');
    const api = await seedTeam(db, 'API');
    const cycle = await db.insert(schema.mergeCycles).values({ id: 'mcy_a', teamId: plat.id, number: 1, startsAt: '2026-11-01', endsAt: '2026-11-14' }).returning();
    await db.insert(schema.mergeLabels).values({ id: 'mlb_bug', teamId: null, name: 'bug' });
    const a = await seedIssue(db, plat.id, 1, { title: 'Login redirect loop', status: 'todo', assigneeUserId: ALICE, cycleId: cycle[0]!.id, labelIds: ['mlb_bug'] });
    const b = await seedIssue(db, plat.id, 2, { title: 'Tabs jump', status: 'in_progress', assigneeUserId: BOB });
    const c = await seedIssue(db, plat.id, 3, { title: 'Dark mode', status: 'done', parentIssueId: a.id });
    const d = await seedIssue(db, api.id, 1, { title: 'Rate limits for login', status: 'backlog' });
    await seedIssue(db, api.id, 2, { title: 'Hidden', deletedAt: new Date() });
    return { plat, api, a, b, c, d };
  }
  const titles = async (query: string, grants = VIEWER, userId = ALICE) =>
    (await ok<MergeIssueDto[]>(await issues(grants, userId).request(`${BASE}${query}`))).map((i) => i.title);

  it('lists newest first with the standard envelope and counts linked pull requests', async () => {
    const { a, d } = await seedList();
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const pr = await seedPullRequest(db, repo.id, 1);
    await db.insert(schema.mergeIssuePullRequests).values({ id: 'mip_1', issueId: a.id, pullRequestId: pr.id, source: 'manual', closes: true });

    const res = await issues(VIEWER).request(BASE);
    const body = (await res.json()) as { data: MergeIssueDto[]; pagination: unknown };
    expect(body.data.map((i) => i.key).sort()).toEqual(['API-1', 'PLAT-1', 'PLAT-2', 'PLAT-3']);
    expect(body.data.find((i) => i.id === a.id)!.pullRequestCount).toBe(1);
    expect(body.data.find((i) => i.id === d.id)!.pullRequestCount).toBe(0);
    expect(body.pagination).toMatchObject({ hasMore: false, cursor: null });
  });

  it('filters by team, status, assignee, cycle, label and parent', async () => {
    const { plat, a } = await seedList();
    expect(await titles(`?teamId=${plat.id}`)).toHaveLength(3);
    expect((await titles('?status=todo,in_progress')).sort()).toEqual(['Login redirect loop', 'Tabs jump']);
    expect(await titles('?assignee=me', VIEWER, ALICE)).toEqual(['Login redirect loop']);
    expect(await titles('?assignee=me', VIEWER, BOB)).toEqual(['Tabs jump']);
    expect(await titles(`?assignee=${BOB}`)).toEqual(['Tabs jump']);
    expect((await titles('?assignee=none')).sort()).toEqual(['Dark mode', 'Rate limits for login']);
    expect(await titles('?cycleId=mcy_a')).toEqual(['Login redirect loop']);
    expect(await titles('?labelId=mlb_bug')).toEqual(['Login redirect loop']);
    expect(await titles(`?parentIssueId=${a.id}`)).toEqual(['Dark mode']);
    expect((await issues(VIEWER).request(`${BASE}?status=bogus`)).status).toBe(400);
  });

  it('searches titles and exact keys, treating % and _ literally', async () => {
    await seedList();
    expect((await titles('?q=login')).sort()).toEqual(['Login redirect loop', 'Rate limits for login']);
    expect(await titles('?q=PLAT-2')).toEqual(['Tabs jump']);
    expect(await titles('?q=plat-2')).toEqual(['Tabs jump']);
    expect(await titles('?q=PLAT-99')).toEqual([]);
    expect(await titles('?q=%25')).toEqual([]);
    expect(await titles('?q=_ogin')).toEqual([]);
    // `%`, `_` and `\` match themselves.
    const team = (await db.select().from(schema.mergeTeams).where(eq(schema.mergeTeams.key, 'API')))[0]!;
    await seedIssue(db, team.id, 3, { title: 'Up 50% faster' });
    await seedIssue(db, team.id, 4, { title: 'Rename snake_case keys' });
    await seedIssue(db, team.id, 5, { title: 'Escape C:\\temp paths' });
    expect(await titles('?q=50%25')).toEqual(['Up 50% faster']);
    expect(await titles('?q=e_c')).toEqual(['Rename snake_case keys']);
    expect(await titles('?q=C%3A%5Ctemp')).toEqual(['Escape C:\\temp paths']);
  });

  it('pages with a cursor', async () => {
    const team = await seedTeam(db, 'PLAT');
    for (let n = 1; n <= 5; n++) await seedIssue(db, team.id, n, { id: `mis_0000000${n}`, title: `Issue ${n}` });
    const first = await issues(VIEWER).request(`${BASE}?limit=2`);
    const page1 = (await first.json()) as { data: MergeIssueDto[]; pagination: { hasMore: boolean; cursor: string } };
    expect(page1.data.map((i) => i.number)).toEqual([5, 4]);
    expect(page1.pagination.hasMore).toBe(true);
    const second = await issues(VIEWER).request(`${BASE}?limit=2&cursor=${page1.pagination.cursor}`);
    const page2 = (await second.json()) as { data: MergeIssueDto[]; pagination: { hasMore: boolean; cursor: string } };
    expect(page2.data.map((i) => i.number)).toEqual([3, 2]);
    const third = await issues(VIEWER).request(`${BASE}?limit=2&cursor=${page2.pagination.cursor}`);
    const page3 = (await third.json()) as { data: MergeIssueDto[]; pagination: { hasMore: boolean; cursor: unknown } };
    expect(page3.data.map((i) => i.number)).toEqual([1]);
    expect(page3.pagination).toMatchObject({ hasMore: false, cursor: null });
    expect((await issues(VIEWER).request(`${BASE}?limit=0`)).status).toBe(400);
    expect((await issues(VIEWER).request(`${BASE}?limit=500`)).status).toBe(400);
  });
});

describe('update', () => {
  it('changes fields, publishes merge_issue:updated with changes, and keeps the key', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id);
    clearEvents();
    const updated = await ok<MergeIssueDto>(
      await issues().request(
        `${BASE}/${issue.id}`,
        jsonInit({ title: ' New title ', priority: 1, assigneeUserId: BOB, estimate: 3, dueDate: '2026-12-01', sortOrder: 2.5, description: null }, 'PATCH'),
      ),
    );
    expect(updated).toMatchObject({
      key: 'PLAT-1',
      title: 'New title',
      priority: 1,
      assigneeUserId: BOB,
      estimate: 3,
      dueDate: '2026-12-01',
      sortOrder: 2.5,
      description: null,
    });
    expect(eventTypes()).toEqual(['merge_issue:updated']);
    expect(events[0]!.changes).toMatchObject({ title: { old: 'Fix the tabs', new: 'New title' }, priority: { old: 0, new: 1 } });
  });

  it('keeps status timestamps consistent as the status moves', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id);
    const patch = (status: string) => issues().request(`${BASE}/${issue.id}`, jsonInit({ status }, 'PATCH')).then((r) => ok<MergeIssueDto>(r));

    const started = await patch('in_progress');
    expect(started.startedAt).not.toBeNull();
    expect(started.completedAt).toBeNull();
    const done = await patch('done');
    expect(done.startedAt).toBe(started.startedAt);
    expect(done.completedAt).not.toBeNull();
    const reopened = await patch('in_review');
    expect(reopened.startedAt).toBe(started.startedAt);
    expect(reopened.completedAt).toBeNull();
    const canceled = await patch('canceled');
    expect(canceled.canceledAt).not.toBeNull();
    expect(canceled.completedAt).toBeNull();
    expect((await patch('todo')).canceledAt).toBeNull();
  });

  it('refuses a cycle, label or parent of another team (400), a self parent and a parent loop', async () => {
    const plat = await seedTeam(db, 'PLAT');
    const api = await seedTeam(db, 'API');
    await db.insert(schema.mergeCycles).values({ id: 'mcy_api', teamId: api.id, number: 1, startsAt: '2026-11-01', endsAt: '2026-11-14' });
    await db.insert(schema.mergeCycles).values({ id: 'mcy_plat', teamId: plat.id, number: 1, startsAt: '2026-11-01', endsAt: '2026-11-14' });
    await db.insert(schema.mergeLabels).values([
      { id: 'mlb_api', teamId: api.id, name: 'api-only' },
      { id: 'mlb_wide', teamId: null, name: 'wide' },
    ]);
    const a = await newIssue(plat.id, { title: 'A' });
    const b = await newIssue(plat.id, { title: 'B', parentIssueId: a.id });
    const c = await newIssue(plat.id, { title: 'C', parentIssueId: b.id });
    const foreign = await newIssue(api.id, { title: 'Foreign' });
    clearEvents();

    const patch = (id: string, body: unknown) => issues().request(`${BASE}/${id}`, jsonInit(body, 'PATCH'));
    expect((await patch(a.id, { cycleId: 'mcy_api' })).status).toBe(400);
    expect((await patch(a.id, { cycleId: 'mcy_unknown' })).status).toBe(400);
    expect((await patch(a.id, { labelIds: ['mlb_api'] })).status).toBe(400);
    expect((await patch(a.id, { labelIds: ['mlb_missing'] })).status).toBe(400);
    expect((await patch(a.id, { parentIssueId: foreign.id })).status).toBe(400);
    expect((await patch(a.id, { parentIssueId: a.id })).status).toBe(400);
    // a is the ancestor of c: making c a's parent would close a loop.
    expect((await patch(a.id, { parentIssueId: c.id })).status).toBe(400);
    expect(events).toEqual([]);

    const fine = await ok<MergeIssueDto>(await patch(a.id, { cycleId: 'mcy_plat', labelIds: ['mlb_wide', 'mlb_wide'], parentIssueId: null }));
    expect(fine).toMatchObject({ cycleId: 'mcy_plat', labelIds: ['mlb_wide'] });
  });

  it('refuses bad input (400, including moving to another team), 404 for an unknown or deleted issue, 403 without update', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id);
    const patch = (id: string, body: unknown, grants = ADMIN) => issues(grants).request(`${BASE}/${id}`, jsonInit(body, 'PATCH'));
    expect((await patch(issue.id, {})).status).toBe(400);
    expect((await patch(issue.id, { status: 'started' })).status).toBe(400);
    expect((await patch(issue.id, { priority: 9 })).status).toBe(400);
    expect((await patch(issue.id, { title: '' })).status).toBe(400);
    // `teamId` is not a field of the update: it is ignored, the issue stays where it is.
    const other = await seedTeam(db, 'API');
    const ignored = await ok<MergeIssueDto>(await patch(issue.id, { teamId: other.id, title: 'Same team' }));
    expect(ignored).toMatchObject({ teamId: team.id, key: 'PLAT-1' });
    expect((await patch('mis_unknown', { title: 'x' })).status).toBe(404);
    expect((await patch(issue.id, { title: 'x' }, VIEWER)).status).toBe(403);
    await issues().request(`${BASE}/${issue.id}`, { method: 'DELETE' });
    expect((await patch(issue.id, { title: 'x' })).status).toBe(404);
  });
});

describe('delete', () => {
  it('soft-deletes, frees the sub-issues, publishes merge_issue:deleted, and needs merge_issues:delete', async () => {
    const team = await seedTeam(db, 'PLAT');
    const parent = await newIssue(team.id, { title: 'Parent' });
    const child = await newIssue(team.id, { title: 'Child', parentIssueId: parent.id });
    clearEvents();

    expect((await issues(MEMBER).request(`${BASE}/${parent.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await issues().request(`${BASE}/mis_unknown`, { method: 'DELETE' })).status).toBe(404);
    expect(events).toEqual([]);

    expect((await issues().request(`${BASE}/${parent.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_issue:deleted']);
    const [row] = await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, parent.id));
    expect(row!.deletedAt).not.toBeNull();
    expect((await ok<MergeIssueDetailDto>(await issues().request(`${BASE}/${child.id}`))).parentIssueId).toBeNull();
    expect((await issues().request(`${BASE}/${parent.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('comments', () => {
  it('lists, creates and publishes merge_comment events', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id);
    clearEvents();
    const first = await ok<MergeCommentDto>(await issues().request(`${BASE}/${issue.id}/comments`, jsonInit({ body: ' First ' })), 201);
    expect(first).toMatchObject({ issueId: issue.id, authorUserId: ALICE, body: 'First' });
    expect(first.id).toMatch(/^mcm_/);
    await ok(await issues(MEMBER, BOB).request(`${BASE}/${issue.id}/comments`, jsonInit({ body: 'Second' })), 201);
    expect(eventTypes()).toEqual(['merge_comment:created', 'merge_comment:created']);

    const listed = await ok<MergeCommentDto[]>(await issues(VIEWER).request(`${BASE}/${issue.id}/comments`));
    expect(listed.map((c) => c.body)).toEqual(['First', 'Second']);
  });

  it('refuses a blank body (400), an unknown issue (404) and a reader writing (403)', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id);
    expect((await issues().request(`${BASE}/${issue.id}/comments`, jsonInit({ body: '   ' }))).status).toBe(400);
    expect((await issues().request(`${BASE}/mis_unknown/comments`, jsonInit({ body: 'x' }))).status).toBe(404);
    expect((await issues().request(`${BASE}/mis_unknown/comments`)).status).toBe(404);
    expect((await issues(VIEWER).request(`${BASE}/${issue.id}/comments`, jsonInit({ body: 'x' }))).status).toBe(403);
  });

  it('lets only the author edit; the author or a holder of merge_issues:delete deletes', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id);
    const mine = await ok<MergeCommentDto>(await issues().request(`${BASE}/${issue.id}/comments`, jsonInit({ body: 'Mine' })), 201);
    clearEvents();

    expect((await comments(ADMIN, BOB).request(`/api/merge/comments/${mine.id}`, jsonInit({ body: 'Hijack' }, 'PATCH'))).status).toBe(403);
    expect((await comments(VIEWER, ALICE).request(`/api/merge/comments/${mine.id}`, jsonInit({ body: 'x' }, 'PATCH'))).status).toBe(403);
    expect((await comments().request(`/api/merge/comments/${mine.id}`, jsonInit({ body: '' }, 'PATCH'))).status).toBe(400);
    expect((await comments().request('/api/merge/comments/mcm_unknown', jsonInit({ body: 'x' }, 'PATCH'))).status).toBe(404);
    const edited = await ok<MergeCommentDto>(await comments().request(`/api/merge/comments/${mine.id}`, jsonInit({ body: 'Edited' }, 'PATCH')));
    expect(edited.body).toBe('Edited');
    expect(eventTypes()).toEqual(['merge_comment:updated']);

    // Bob can write but not delete Alice's comment without merge_issues:delete.
    expect((await comments(MEMBER, BOB).request(`/api/merge/comments/${mine.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await comments(ADMIN, BOB).request(`/api/merge/comments/${mine.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_comment:updated', 'merge_comment:deleted']);
    expect((await comments().request(`/api/merge/comments/${mine.id}`, { method: 'DELETE' })).status).toBe(404);

    const bobs = await ok<MergeCommentDto>(await issues(MEMBER, BOB).request(`${BASE}/${issue.id}/comments`, jsonInit({ body: 'Bob' })), 201);
    expect((await comments(MEMBER, BOB).request(`/api/merge/comments/${bobs.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await ok<MergeCommentDto[]>(await issues().request(`${BASE}/${issue.id}/comments`))).toEqual([]);
  });
});

describe('pull request links', () => {
  async function setup(prOverrides: Parameters<typeof seedPullRequest>[3] = {}) {
    const team = await seedTeam(db, 'PLAT');
    const issue = await newIssue(team.id, { status: 'todo' });
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const pr = await seedPullRequest(db, repo.id, 3, prOverrides);
    clearEvents();
    return { issue, pr };
  }

  it('links by hand (source manual), and a ready pull request moves the issue to in_review', async () => {
    const { issue, pr } = await setup({ draft: false });
    const detail = await ok<MergeIssueDetailDto>(await issues().request(`${BASE}/${issue.id}/pull-requests`, jsonInit({ pullRequestId: pr.id })));
    expect(detail.status).toBe('in_review');
    expect(detail.pullRequests[0]).toMatchObject({ id: pr.id, link: { source: 'manual', closes: true } });
    expect(eventTypes()).toEqual(['merge_issue:updated']);
    expect(events[0]!.data).toMatchObject({ key: 'PLAT-1', status: 'in_review', movedByPullRequestId: pr.id });
  });

  it('a merged pull request that closes moves a new link to done; one that only refs does not', async () => {
    const { issue, pr } = await setup({ state: 'merged', mergedAt: new Date('2026-11-02T10:00:00Z') });
    const refs = await ok<MergeIssueDetailDto>(
      await issues().request(`${BASE}/${issue.id}/pull-requests`, jsonInit({ pullRequestId: pr.id, closes: false })),
    );
    expect(refs.status).toBe('todo');
    expect(refs.pullRequests[0]!.link.closes).toBe(false);

    // Linking again only changes `closes`; it is not a new link, so no automation runs.
    const again = await ok<MergeIssueDetailDto>(
      await issues().request(`${BASE}/${issue.id}/pull-requests`, jsonInit({ pullRequestId: pr.id, closes: true })),
    );
    expect(again.status).toBe('todo');
    expect(again.pullRequests[0]!.link.closes).toBe(true);

    const other = await newIssue(issue.teamId, { status: 'in_progress' });
    const closed = await ok<MergeIssueDetailDto>(await issues().request(`${BASE}/${other.id}/pull-requests`, jsonInit({ pullRequestId: pr.id })));
    expect(closed.status).toBe('done');
    expect(closed.completedAt).not.toBeNull();
  });

  it('never moves a done issue back, and does not move for a closed pull request', async () => {
    const { issue, pr } = await setup({ state: 'closed' });
    const noMove = await ok<MergeIssueDetailDto>(await issues().request(`${BASE}/${issue.id}/pull-requests`, jsonInit({ pullRequestId: pr.id })));
    expect(noMove.status).toBe('todo');
    const finished = await newIssue(issue.teamId, { status: 'done' });
    const [ready] = await db.select().from(schema.mergeRepositories);
    const openPr = await seedPullRequest(db, ready!.id, 9, { draft: false });
    const stays = await ok<MergeIssueDetailDto>(await issues().request(`${BASE}/${finished.id}/pull-requests`, jsonInit({ pullRequestId: openPr.id })));
    expect(stays.status).toBe('done');
  });

  it('unlinks, answers 404 for what is not linked, and refuses an unknown pull request', async () => {
    const { issue, pr } = await setup();
    expect((await issues().request(`${BASE}/${issue.id}/pull-requests`, jsonInit({ pullRequestId: 'mpr_unknown' }))).status).toBe(404);
    expect((await issues().request(`${BASE}/${issue.id}/pull-requests`, jsonInit({}))).status).toBe(400);
    expect((await issues().request(`${BASE}/mis_unknown/pull-requests`, jsonInit({ pullRequestId: pr.id }))).status).toBe(404);
    expect((await issues().request(`${BASE}/${issue.id}/pull-requests/${pr.id}`, { method: 'DELETE' })).status).toBe(404);

    await issues().request(`${BASE}/${issue.id}/pull-requests`, jsonInit({ pullRequestId: pr.id }));
    clearEvents();
    expect((await issues(VIEWER).request(`${BASE}/${issue.id}/pull-requests/${pr.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await issues().request(`${BASE}/${issue.id}/pull-requests/${pr.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_issue:updated']);
    expect((await ok<MergeIssueDetailDto>(await issues().request(`${BASE}/${issue.id}`))).pullRequests).toEqual([]);
  });
});
