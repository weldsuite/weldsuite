/**
 * DB-backed tests for /api/merge/pull-requests, /accounts/me and /inbox on a
 * real tenant schema (pglite). What must not regress:
 *   1. The views: needs_review (open, not draft, the member's GitHub login among
 *      the requested reviewers), mine (open, authored by the member), open,
 *      merged, closed.
 *   2. A member edits only their own login (stored lower-case); another member
 *      holding it is a 409; saving back-fills the pull requests it authored.
 *   3. The inbox is derived per request, newest first, and leaves assigned
 *      issues out without merge_issues:read.
 *   4. The mirror has no write routes.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  MergeInboxItem,
  MergePullRequestDetailDto,
  MergePullRequestListItem,
  MergeProviderAccountsDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import pullRequestsRoutes from './index';
import accountsRoutes from '../accounts';
import inboxRoutes from '../inbox';
import { ADMIN, ALICE, BOB, VIEWER, errorCode, events, jsonInit, makeApp, ok, openDb, resetTables } from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

const BASE = '/api/merge/pull-requests';
const prs = (grants = ADMIN, userId = ALICE) => makeApp(db, BASE, pullRequestsRoutes, { grants, userId });
const accounts = (grants = ADMIN, userId = ALICE) => makeApp(db, '/api/merge/accounts', accountsRoutes, { grants, userId });
const inbox = (grants = ADMIN, userId = ALICE) => makeApp(db, '/api/merge/inbox', inboxRoutes, { grants, userId });

const listNumbers = async (query: string, grants = VIEWER, userId = ALICE) =>
  (await ok<MergePullRequestListItem[]>(await prs(grants, userId).request(`${BASE}${query}`))).map((p) => p.number);

async function seedLogin(userId: string, login: string) {
  await db.insert(schema.mergeProviderAccounts).values({ id: `mpa_${userId}`, userId, provider: 'github', login });
}

describe('pull request list views', () => {
  async function seedViews() {
    await seedLogin(ALICE, 'alice-gh');
    const connection = await seedConnection(db);
    const web = await seedRepository(db, connection.id, { externalId: '900', fullName: 'acme/web' });
    const api = await seedRepository(db, connection.id, { externalId: '901', fullName: 'acme/api' });
    const t = (hour: number) => new Date(`2026-11-01T${String(hour).padStart(2, '0')}:00:00Z`);
    // 1: asks Alice for a review. 2: draft asking her, not listed. 3: Alice's own. 4: a teammate's, no review asked.
    await seedPullRequest(db, web.id, 1, { providerUpdatedAt: t(10), authorLogin: 'bob-gh', requestedReviewers: [{ kind: 'user', login: 'alice-gh' }] });
    await seedPullRequest(db, web.id, 2, { providerUpdatedAt: t(11), draft: true, authorLogin: 'bob-gh', requestedReviewers: [{ kind: 'user', login: 'alice-gh' }] });
    await seedPullRequest(db, web.id, 3, { providerUpdatedAt: t(12), authorLogin: 'alice-gh', authorUserId: ALICE });
    await seedPullRequest(db, api.id, 4, { providerUpdatedAt: t(13), authorLogin: 'bob-gh' });
    await seedPullRequest(db, api.id, 5, { providerUpdatedAt: t(14), state: 'merged', mergedAt: t(14), authorLogin: 'alice-gh' });
    await seedPullRequest(db, api.id, 6, { providerUpdatedAt: t(15), state: 'closed', closedAt: t(15), authorLogin: 'bob-gh' });
    return { web, api };
  }

  it('needs_review lists open, non-draft pull requests that ask the member, and is empty without a login', async () => {
    await seedViews();
    expect(await listNumbers('?view=needs_review')).toEqual([1]);
    expect(await listNumbers('?view=needs_review', VIEWER, BOB)).toEqual([]);
  });

  it('needs_review matches the login case-insensitively as saved, ignoring team reviewers', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    await seedLogin(ALICE, 'alice-gh');
    await seedPullRequest(db, repo.id, 1, { requestedReviewers: [{ kind: 'team', login: 'alice-gh' }] });
    expect(await listNumbers('?view=needs_review')).toEqual([]);
  });

  it('mine lists open pull requests authored by the member (by user id or by login)', async () => {
    const { web } = await seedViews();
    await seedPullRequest(db, web.id, 7, { authorLogin: 'someone', authorUserId: ALICE, providerUpdatedAt: new Date('2026-11-01T16:00:00Z') });
    expect(await listNumbers('?view=mine')).toEqual([7, 3]);
    expect(await listNumbers('?view=mine', VIEWER, BOB)).toEqual([]);
  });

  it('open (the default), merged and closed split by state, newest update first', async () => {
    await seedViews();
    expect(await listNumbers('')).toEqual([4, 3, 2, 1]);
    expect(await listNumbers('?view=open')).toEqual([4, 3, 2, 1]);
    expect(await listNumbers('?view=merged')).toEqual([5]);
    expect(await listNumbers('?view=closed')).toEqual([6]);
    expect((await prs(VIEWER).request(`${BASE}?view=everything`)).status).toBe(400);
  });

  it('filters by repository, team and search, and hides pull requests of removed repositories', async () => {
    const { web, api } = await seedViews();
    const team = await seedTeam(db, 'PLAT');
    await db.update(schema.mergeRepositories).set({ teamId: team.id }).where(eq(schema.mergeRepositories.id, api.id));
    expect(await listNumbers(`?view=open&repositoryId=${web.id}`)).toEqual([3, 2, 1]);
    expect(await listNumbers(`?view=open&teamId=${team.id}`)).toEqual([4]);
    expect(await listNumbers('?view=merged&q=api')).toEqual([5]);
    expect(await listNumbers('?view=open&q=%23' + '3')).toEqual([3]);
    expect(await listNumbers('?view=open&q=Pull request 1')).toEqual([1]);
    expect(await listNumbers('?view=open&q=%25')).toEqual([]);

    await db.update(schema.mergeRepositories).set({ deletedAt: new Date() }).where(eq(schema.mergeRepositories.id, api.id));
    expect(await listNumbers('?view=open')).toEqual([3, 2, 1]);
  });

  it('carries the repository name, the repository team and the linked issues on each row', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await seedIssue(db, team.id, 209, { title: 'Tabs jump', status: 'in_review' });
    const gone = await seedIssue(db, team.id, 210, { deletedAt: new Date() });
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id, { teamId: team.id });
    const pr = await seedPullRequest(db, repo.id, 1, { checksStatus: 'success', reviewDecision: 'approved', labels: [{ name: 'bug', color: '#d73a4a' }] });
    await db.insert(schema.mergeIssuePullRequests).values([
      { id: 'mip_a', issueId: issue.id, pullRequestId: pr.id, source: 'auto', closes: false },
      { id: 'mip_b', issueId: gone.id, pullRequestId: pr.id, source: 'auto', closes: true },
    ]);
    const [row] = await ok<MergePullRequestListItem[]>(await prs(VIEWER).request(BASE));
    expect(row).toMatchObject({
      id: pr.id,
      repositoryFullName: 'acme/web',
      teamId: team.id,
      provider: 'github',
      checksStatus: 'success',
      reviewDecision: 'approved',
      labels: [{ name: 'bug', color: '#d73a4a' }],
    });
    expect(row!.issues).toEqual([{ id: issue.id, key: 'PLAT-209', title: 'Tabs jump', status: 'in_review', source: 'auto', closes: false }]);
  });

  it('pages with a cursor', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    for (let n = 1; n <= 5; n++) {
      await seedPullRequest(db, repo.id, n, { providerUpdatedAt: new Date(`2026-11-0${n}T10:00:00Z`) });
    }
    // Two share the same update time: the id breaks the tie.
    await seedPullRequest(db, repo.id, 6, { providerUpdatedAt: new Date('2026-11-05T10:00:00Z') });
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await prs(VIEWER).request(`${BASE}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const body = (await res.json()) as { data: MergePullRequestListItem[]; pagination: { hasMore: boolean; cursor: string | null } };
      seen.push(...body.data.map((p) => p.number));
      cursor = body.pagination.cursor;
      if (!body.pagination.hasMore) break;
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(seen).size).toBe(6);
    expect(seen.slice(-1)).toEqual([1]);
  });

  it('reads one pull request with its body, head sha and linked issues, 404 for an unknown one', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const pr = await seedPullRequest(db, repo.id, 1, { body: 'Closes PLAT-1', headSha: 'abc123' });
    const detail = await ok<MergePullRequestDetailDto>(await prs(VIEWER).request(`${BASE}/${pr.id}`));
    expect(detail).toMatchObject({ id: pr.id, body: 'Closes PLAT-1', headSha: 'abc123', issues: [], repositoryFullName: 'acme/web' });
    expect(typeof detail.syncedAt).toBe('string');
    const missing = await prs(VIEWER).request(`${BASE}/mpr_unknown`);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('NOT_FOUND');
  });

  it('needs merge_pull_requests:read, and offers no write routes', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const pr = await seedPullRequest(db, repo.id, 1);
    expect((await prs(['merge_issues:read']).request(BASE)).status).toBe(403);
    expect((await prs(['merge_issues:read']).request(`${BASE}/${pr.id}`)).status).toBe(403);
    // The router itself has no write routes (asked directly: an unrouted
    // request is no route either backend answers alike, so not through the app).
    expect((await pullRequestsRoutes.request('/', jsonInit({ title: 'x' }))).status).toBe(404);
    expect((await pullRequestsRoutes.request(`/${pr.id}`, jsonInit({ title: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await pullRequestsRoutes.request(`/${pr.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('accounts/me', () => {
  const ME = '/api/merge/accounts/me';

  it('saves the login lower-case, reads it back, and removes it with an empty value', async () => {
    expect(await ok<MergeProviderAccountsDto>(await accounts().request(ME))).toEqual({ github: null });
    expect(await ok<MergeProviderAccountsDto>(await accounts().request(ME, jsonInit({ github: ' Alice-GH ' }, 'PUT')))).toEqual({ github: 'alice-gh' });
    expect(await ok<MergeProviderAccountsDto>(await accounts().request(ME))).toEqual({ github: 'alice-gh' });
    // Changing it keeps one row.
    await accounts().request(ME, jsonInit({ github: 'alice-two' }, 'PUT'));
    expect(await db.select().from(schema.mergeProviderAccounts)).toHaveLength(1);
    expect(await ok<MergeProviderAccountsDto>(await accounts().request(ME, jsonInit({ github: '' }, 'PUT')))).toEqual({ github: null });
    expect(await db.select().from(schema.mergeProviderAccounts)).toEqual([]);
    expect(await ok<MergeProviderAccountsDto>(await accounts().request(ME, jsonInit({ github: null }, 'PUT')))).toEqual({ github: null });
    expect(events).toEqual([]);
  });

  it("keeps accounts apart per member, and refuses another member's login with 409", async () => {
    await accounts(ADMIN, ALICE).request(ME, jsonInit({ github: 'octo' }, 'PUT'));
    const clash = await accounts(ADMIN, BOB).request(ME, jsonInit({ github: 'OCTO' }, 'PUT'));
    expect(clash.status).toBe(409);
    expect(await errorCode(clash)).toBe('CONFLICT');
    expect(await ok<MergeProviderAccountsDto>(await accounts(ADMIN, BOB).request(ME))).toEqual({ github: null });
    expect(await ok<MergeProviderAccountsDto>(await accounts(ADMIN, ALICE).request(ME))).toEqual({ github: 'octo' });
  });

  it('refuses a malformed login, and needs merge_pull_requests:read', async () => {
    for (const github of ['has space', '-leading', 'a'.repeat(40), 'emoji🙂']) {
      expect((await accounts().request(ME, jsonInit({ github }, 'PUT'))).status, github).toBe(400);
    }
    expect((await accounts(['merge_issues:read']).request(ME)).status).toBe(403);
    expect((await accounts(['merge_issues:read']).request(ME, jsonInit({ github: 'x' }, 'PUT'))).status).toBe(403);
  });

  it('back-fills author_user_id on that login\'s pull requests, and releases them when the login changes or goes', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const mine = await seedPullRequest(db, repo.id, 1, { authorLogin: 'alice-gh' });
    const theirs = await seedPullRequest(db, repo.id, 2, { authorLogin: 'bob-gh' });
    const userOf = async (id: string) => (await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.id, id)))[0]!.authorUserId;

    await accounts(ADMIN, ALICE).request(ME, jsonInit({ github: 'Alice-GH' }, 'PUT'));
    expect(await userOf(mine.id)).toBe(ALICE);
    expect(await userOf(theirs.id)).toBeNull();

    await accounts(ADMIN, ALICE).request(ME, jsonInit({ github: 'alice-new' }, 'PUT'));
    expect(await userOf(mine.id)).toBeNull();

    await accounts(ADMIN, ALICE).request(ME, jsonInit({ github: 'alice-gh' }, 'PUT'));
    expect(await userOf(mine.id)).toBe(ALICE);
    await accounts(ADMIN, ALICE).request(ME, jsonInit({ github: null }, 'PUT'));
    expect(await userOf(mine.id)).toBeNull();
  });
});

describe('inbox', () => {
  const kinds = async (grants = ADMIN, userId = ALICE) =>
    (await ok<MergeInboxItem[]>(await inbox(grants, userId).request('/api/merge/inbox'))).map((i) => i.id.split(':')[0] + ':' + (i.pullRequest?.number ?? i.issue?.key));

  it('is empty for a member with nothing to do', async () => {
    const res = await inbox().request('/api/merge/inbox');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  });

  it('derives each kind, newest first, from the mirror and the issues', async () => {
    await seedLogin(ALICE, 'alice-gh');
    const team = await seedTeam(db, 'PLAT');
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const recent = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

    // Asks for Alice's review.
    await seedPullRequest(db, repo.id, 1, { authorLogin: 'bob-gh', requestedReviewers: [{ kind: 'user', login: 'alice-gh' }], providerUpdatedAt: recent(5) });
    // Alice's PR with failed checks, and one with changes requested.
    await seedPullRequest(db, repo.id, 2, { authorLogin: 'alice-gh', authorUserId: ALICE, checksStatus: 'failure', providerUpdatedAt: recent(4) });
    await seedPullRequest(db, repo.id, 3, { authorLogin: 'alice-gh', authorUserId: ALICE, reviewDecision: 'changes_requested', providerUpdatedAt: recent(3) });
    // Alice's PR merged an hour ago, and one merged a week ago (too old).
    await seedPullRequest(db, repo.id, 4, { authorLogin: 'alice-gh', authorUserId: ALICE, state: 'merged', mergedAt: recent(1), providerUpdatedAt: recent(1) });
    await seedPullRequest(db, repo.id, 5, { authorLogin: 'alice-gh', authorUserId: ALICE, state: 'merged', mergedAt: recent(24 * 7), providerUpdatedAt: recent(24 * 7) });
    // Not Alice's, or nothing to act on.
    await seedPullRequest(db, repo.id, 6, { authorLogin: 'bob-gh', checksStatus: 'failure', providerUpdatedAt: recent(2) });
    await seedPullRequest(db, repo.id, 7, { authorLogin: 'alice-gh', authorUserId: ALICE, checksStatus: 'success', reviewDecision: 'approved', providerUpdatedAt: recent(2) });
    // Draft that asks for Alice is not a review request yet.
    await seedPullRequest(db, repo.id, 8, { authorLogin: 'bob-gh', draft: true, requestedReviewers: [{ kind: 'user', login: 'alice-gh' }], providerUpdatedAt: recent(2) });
    // Issues: assigned and fresh; assigned and stale; fresh for someone else; deleted.
    await seedIssue(db, team.id, 1, { assigneeUserId: ALICE, updatedAt: recent(6) });
    await seedIssue(db, team.id, 2, { assigneeUserId: ALICE, updatedAt: recent(24 * 20) });
    await seedIssue(db, team.id, 3, { assigneeUserId: BOB, updatedAt: recent(1) });
    await seedIssue(db, team.id, 4, { assigneeUserId: ALICE, updatedAt: recent(1), deletedAt: new Date() });

    const items = await ok<MergeInboxItem[]>(await inbox().request('/api/merge/inbox'));
    expect(items.map((i) => `${i.kind}:${i.pullRequest?.number ?? i.issue?.key}`).sort()).toEqual(
      ['assigned:PLAT-1', 'changes_requested:3', 'checks_failed:2', 'merged:4', 'review_requested:1'],
    );
    // Newest first.
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort().reverse());
    expect(items.find((i) => i.kind === 'review_requested')!.pullRequest).toMatchObject({ repositoryFullName: 'acme/web' });
    expect(items.find((i) => i.kind === 'assigned')!.issue).toMatchObject({ key: 'PLAT-1' });
    expect(items.every((i) => (i.pullRequest === null) !== (i.issue === null))).toBe(true);
  });

  it('leaves the assigned issues out without merge_issues:read, and needs merge_pull_requests:read', async () => {
    const team = await seedTeam(db, 'PLAT');
    await seedIssue(db, team.id, 1, { assigneeUserId: ALICE });
    expect(await kinds(['merge_pull_requests:read'])).toEqual([]);
    expect(await kinds(VIEWER)).toEqual(['assigned:PLAT-1']);
    expect((await inbox(['merge_issues:read']).request('/api/merge/inbox')).status).toBe(403);
  });

  it('is the member\'s own: another member sees nothing of it', async () => {
    await seedLogin(ALICE, 'alice-gh');
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    await seedPullRequest(db, repo.id, 1, { requestedReviewers: [{ kind: 'user', login: 'alice-gh' }] });
    expect(await kinds(ADMIN, ALICE)).toEqual(['review_requested:1']);
    expect(await kinds(ADMIN, BOB)).toEqual([]);
  });
});

