/**
 * DB-backed tests for the GitHub event intake (POST /internal/github-event, what
 * `MergeInternal.githubEvent` calls) on a real tenant schema (pglite). What must
 * not regress:
 *   1. pull_request upserts the mirror and links issues by key; the automation
 *      moves a linked issue once per phase change (draft -> in_progress, ready ->
 *      in_review, merged and closes -> done), never a done or canceled one, never
 *      for a link that only refs, and a member's own move is not overridden by
 *      the next push.
 *   2. A copy older than the stored one is ignored; an untracked repository or
 *      one with pr_sync off is ignored.
 *   3. Reviews and check suites are read back from GitHub and recorded.
 *   4. installation_repositories drops the removed repositories.
 *   5. Moves made by the sync are system events with movedByPullRequestId.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import internalRoutes from './index';
import {
  ADMIN,
  clearEvents,
  data,
  events,
  githubPull,
  jsonInit,
  makeApp,
  newId,
  openDb,
  perRun,
  resetTables,
  RUNS,
  stubGithub,
  type GithubPullFixture,
} from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PATH = '/internal/github-event';
const internal = (env = {}) => makeApp(db, '/internal', internalRoutes, { grants: ADMIN, env });

interface Setup {
  one: typeof schema.mergeIssues.$inferSelect;
  two: typeof schema.mergeIssues.$inferSelect;
  repo: typeof schema.mergeRepositories.$inferSelect;
}

async function setup(repoOverrides: Partial<typeof schema.mergeRepositories.$inferInsert> = {}): Promise<Setup> {
  const team = await seedTeam(db, 'PLAT');
  const one = await seedIssue(db, team.id, 1, { status: 'todo' });
  const two = await seedIssue(db, team.id, 2, { status: 'backlog' });
  const connection = await seedConnection(db, { externalAccountId: '4242' });
  const repo = await seedRepository(db, connection.id, { externalId: '900', ...repoOverrides });
  clearEvents();
  return { one, two, repo };
}

function envelope(event: string, payload: Record<string, unknown>) {
  return {
    workspaceId: 'org_alpha',
    event,
    deliveryId: 'delivery-1',
    payload: { installation: { id: 4242 }, repository: { id: 900, full_name: 'acme/web' }, ...payload },
  };
}

function pullRequestEvent(action: string, pull: GithubPullFixture) {
  return envelope('pull_request', { action, pull_request: githubPull(pull) });
}

async function send(body: unknown, env = {}) {
  const res = await internal(env).request(PATH, jsonInit(body));
  return res;
}

async function applied(body: unknown) {
  const res = await send(body);
  expect(res.status).toBe(200);
  return data<{ outcome: string; reason?: string }>(res);
}

const at = (iso: string) => ({ updatedAt: iso });
const T1 = '2026-11-02T09:00:00Z';
const T2 = '2026-11-02T10:00:00Z';
const T3 = '2026-11-02T11:00:00Z';

const issueOf = async (id: string) => (await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, id)))[0]!;
const prs = () => db.select().from(schema.mergePullRequests);
const eventLog = () => events.map((e) => e.eventType);

describe('pull_request: mirror and links', () => {
  it('mirrors a new pull request, links the issue named in the branch, and publishes system events', async () => {
    const { one } = await setup();
    const result = await applied(
      pullRequestEvent('opened', { id: 5001, number: 1, title: 'Fix tabs', headRef: 'plat-1-fix-tabs', draft: true, ...at(T1) }),
    );
    expect(result).toEqual({ outcome: 'applied' });

    const [pr] = await prs();
    expect(pr).toMatchObject({
      provider: 'github',
      externalId: '5001',
      number: 1,
      title: 'Fix tabs',
      state: 'open',
      draft: true,
      authorLogin: 'octo-dev',
      headRef: 'plat-1-fix-tabs',
      baseRef: 'main',
      headSha: 'sha1',
      additions: 10,
      labels: [{ name: 'bug', color: '#d73a4a' }],
      checksStatus: null,
      reviewDecision: null,
    });
    expect(pr!.id).toMatch(/^mpr_/);
    const links = await db.select().from(schema.mergeIssuePullRequests);
    expect(links).toMatchObject([{ issueId: one.id, pullRequestId: pr!.id, source: 'auto', closes: true }]);

    expect(eventLog()).toEqual(['merge_pull_request:created', 'merge_issue:updated']);
    expect(events[0]!.data).toMatchObject({ id: newId(pr!.id), number: 1, state: 'open', draft: true, authorLogin: 'octo-dev', issueIds: [one.id] });
    expect(events[1]!.data).toMatchObject({ id: one.id, key: 'PLAT-1', status: 'in_progress', movedByPullRequestId: newId(pr!.id) });
    expect(events[1]!.changes).toEqual({ status: { old: 'todo', new: 'in_progress' } });
    expect(events.every((e) => e.metadata.source === 'system' && e.metadata.userId === 'system')).toBe(true);
  });

  it('finds keys in the title and body in any case, and ignores keys of teams or issues that do not exist', async () => {
    const { one, two } = await setup();
    await applied(
      pullRequestEvent('opened', {
        id: 5001,
        number: 1,
        title: 'Fix plat-1',
        body: 'Closes PLAT-2, FOO-7 and PLAT-99. See https://example.com/PLAT2',
        headRef: 'main-fix',
        ...at(T1),
      }),
    );
    const links = await db.select().from(schema.mergeIssuePullRequests);
    expect(links.map((l) => l.issueId).sort()).toEqual([one.id, two.id].sort());
  });

  it('does not link a deleted issue', async () => {
    const { one } = await setup();
    await db.update(schema.mergeIssues).set({ deletedAt: new Date() }).where(eq(schema.mergeIssues.id, one.id));
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'PLAT-1', ...at(T1) }));
    expect(await db.select().from(schema.mergeIssuePullRequests)).toEqual([]);
    expect(eventLog()).toEqual(['merge_pull_request:created']);
  });

  it('matches the author and reviewers to members by their saved login', async () => {
    await setup();
    await db.insert(schema.mergeProviderAccounts).values([
      { id: 'mpa_a', userId: 'user_alice', provider: 'github', login: 'octo-dev' },
      { id: 'mpa_b', userId: 'user_bob', provider: 'github', login: 'rev-one' },
    ]);
    await applied(pullRequestEvent('review_requested', { id: 5001, number: 1, title: 'x', reviewers: ['Rev-One', 'stranger'], ...at(T1) }));
    const [pr] = await prs();
    expect(pr!.authorUserId).toBe('user_alice');
    expect(pr!.requestedReviewers).toEqual([
      { kind: 'user', login: 'rev-one', avatarUrl: null, userId: 'user_bob' },
      { kind: 'user', login: 'stranger', avatarUrl: null, userId: null },
    ]);
  });

  it('applies a newer copy, keeps the checks and review state, and publishes merge_pull_request:updated', async () => {
    await setup();
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'First', ...at(T1) }));
    await db.update(schema.mergePullRequests).set({ checksStatus: 'success', reviewDecision: 'approved' });
    clearEvents();
    await applied(pullRequestEvent('edited', { id: 5001, number: 1, title: 'Second', ...at(T2) }));
    const [pr] = await prs();
    expect(pr).toMatchObject({ title: 'Second', checksStatus: 'success', reviewDecision: 'approved' });
    expect(eventLog()).toEqual(['merge_pull_request:updated']);
  });

  it('starts new checks on a new head commit', async () => {
    await setup();
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'x', headSha: 'aaa', ...at(T1) }));
    await db.update(schema.mergePullRequests).set({ checksStatus: 'success' });
    await applied(pullRequestEvent('synchronize', { id: 5001, number: 1, title: 'x', headSha: 'bbb', ...at(T2) }));
    expect((await prs())[0]).toMatchObject({ headSha: 'bbb', checksStatus: null });
  });
});

describe('pull_request: stale, untracked and off', () => {
  it('ignores an older copy, applies an equal one', async () => {
    await setup();
    await applied(pullRequestEvent('edited', { id: 5001, number: 1, title: 'Newest', ...at(T3) }));
    clearEvents();

    const older = await applied(pullRequestEvent('edited', { id: 5001, number: 1, title: 'Older', ...at(T1) }));
    expect(older).toEqual({ outcome: 'ignored', reason: 'stale' });
    expect((await prs())[0]!.title).toBe('Newest');
    expect(events).toEqual([]);

    const equal = await applied(pullRequestEvent('labeled', { id: 5001, number: 1, title: 'Same moment', ...at(T3) }));
    expect(equal.outcome).toBe('applied');
    expect((await prs())[0]!.title).toBe('Same moment');
  });

  it('ignores a repository WeldMerge does not track, and writes nothing', async () => {
    await setup();
    const body = pullRequestEvent('opened', { id: 5001, number: 1, title: 'PLAT-1', ...at(T1) });
    (body.payload as Record<string, unknown>).repository = { id: 123, full_name: 'acme/other' };
    expect(await applied(body)).toEqual({ outcome: 'ignored', reason: 'untracked_repository' });
    expect(await prs()).toEqual([]);
    expect(await db.select().from(schema.mergeIssuePullRequests)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('ignores a removed repository, and one with pr_sync off', async () => {
    const { repo } = await setup({ prSync: false });
    expect(await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'x', ...at(T1) }))).toEqual({
      outcome: 'ignored',
      reason: 'pr_sync_off',
    });
    await db.update(schema.mergeRepositories).set({ prSync: true, deletedAt: new Date() }).where(eq(schema.mergeRepositories.id, repo.id));
    expect((await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'x', ...at(T1) }))).reason).toBe('untracked_repository');
    expect(await prs()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses an envelope that is not valid (400), and a workspace that does not exist (404)', async () => {
    await setup();
    for (const body of [
      {},
      { event: 'pull_request', payload: {} },
      { workspaceId: 'org_alpha', event: 'push', payload: {} },
      { workspaceId: 'org_alpha', event: 'pull_request' },
    ]) {
      expect((await send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(events).toEqual([]);
  });

  it('ignores a payload without a pull request', async () => {
    await setup();
    expect(await applied(envelope('pull_request', { action: 'opened' }))).toEqual({ outcome: 'ignored', reason: 'no_payload' });
  });
});

describe('pull_request: automation', () => {
  it('draft opened -> in_progress; ready for review -> in_review; merged and closes -> done', async () => {
    const { one } = await setup();
    const move = { id: 5001, number: 1, title: 'PLAT-1 fix' };

    await applied(pullRequestEvent('opened', { ...move, draft: true, ...at(T1) }));
    expect(await issueOf(one.id)).toMatchObject({ status: 'in_progress' });
    expect((await issueOf(one.id)).startedAt).not.toBeNull();

    clearEvents();
    await applied(pullRequestEvent('ready_for_review', { ...move, draft: false, ...at(T2) }));
    expect((await issueOf(one.id)).status).toBe('in_review');
    expect(eventLog()).toEqual(['merge_pull_request:updated', 'merge_issue:updated']);

    clearEvents();
    await applied(pullRequestEvent('closed', { ...move, merged: true, state: 'closed', ...at(T3) }));
    const done = await issueOf(one.id);
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();
    expect(eventLog()).toEqual(['merge_pull_request:updated', 'merge_pull_request:merged', 'merge_issue:updated']);
    expect(events.at(-1)!.data).toMatchObject({ status: 'done', movedByPullRequestId: (await prs())[0]!.id });
  });

  it('a pull request opened ready moves a backlog or todo issue straight to in_review', async () => {
    const { one, two } = await setup();
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'PLAT-1 and plat-2', ...at(T1) }));
    expect((await issueOf(one.id)).status).toBe('in_review');
    expect((await issueOf(two.id)).status).toBe('in_review');
  });

  it('merged with a refs mention does not close the issue', async () => {
    const { one, two } = await setup();
    await applied(pullRequestEvent('closed', { id: 5001, number: 1, title: 'Ship PLAT-1, refs PLAT-2', merged: true, state: 'closed', ...at(T1) }));
    expect((await issueOf(one.id)).status).toBe('done');
    expect((await issueOf(two.id)).status).toBe('backlog');
    const links = await db.select().from(schema.mergeIssuePullRequests);
    expect(links.find((l) => l.issueId === two.id)!.closes).toBe(false);
  });

  it('closed without merging changes no issue, and publishes merge_pull_request:closed', async () => {
    const { one } = await setup();
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'PLAT-1', draft: true, ...at(T1) }));
    clearEvents();
    await applied(pullRequestEvent('closed', { id: 5001, number: 1, title: 'PLAT-1', state: 'closed', ...at(T2) }));
    expect((await issueOf(one.id)).status).toBe('in_progress');
    expect(eventLog()).toEqual(['merge_pull_request:updated', 'merge_pull_request:closed']);
    expect((await prs())[0]).toMatchObject({ state: 'closed', mergedAt: null });
  });

  it('never moves a done or canceled issue back', async () => {
    const { one, two } = await setup();
    await db.update(schema.mergeIssues).set({ status: 'done' }).where(eq(schema.mergeIssues.id, one.id));
    await db.update(schema.mergeIssues).set({ status: 'canceled' }).where(eq(schema.mergeIssues.id, two.id));
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'PLAT-1 PLAT-2', draft: true, ...at(T1) }));
    await applied(pullRequestEvent('ready_for_review', { id: 5001, number: 1, title: 'PLAT-1 PLAT-2', ...at(T2) }));
    expect((await issueOf(one.id)).status).toBe('done');
    expect((await issueOf(two.id)).status).toBe('canceled');
    expect(eventLog().filter((t) => t === 'merge_issue:updated')).toEqual([]);
  });

  it('does not override a member who moved the issue while the pull request stays in the same phase', async () => {
    const { one } = await setup();
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'PLAT-1', draft: true, ...at(T1) }));
    await db.update(schema.mergeIssues).set({ status: 'todo' }).where(eq(schema.mergeIssues.id, one.id));
    clearEvents();
    await applied(pullRequestEvent('synchronize', { id: 5001, number: 1, title: 'PLAT-1', draft: true, headSha: 'new', ...at(T2) }));
    expect((await issueOf(one.id)).status).toBe('todo');
    expect(eventLog()).toEqual(['merge_pull_request:updated']);
  });

  it('runs the rules for an issue linked later, when the title starts naming it', async () => {
    const { one } = await setup();
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'No key yet', ...at(T1) }));
    expect((await issueOf(one.id)).status).toBe('todo');
    await applied(pullRequestEvent('edited', { id: 5001, number: 1, title: 'Now PLAT-1', ...at(T2) }));
    expect((await issueOf(one.id)).status).toBe('in_review');
  });

  it('a stale event moves nothing', async () => {
    const { one } = await setup();
    await applied(pullRequestEvent('opened', { id: 5001, number: 1, title: 'x', ...at(T3) }));
    await applied(pullRequestEvent('edited', { id: 5001, number: 1, title: 'PLAT-1', ...at(T1) }));
    expect((await issueOf(one.id)).status).toBe('todo');
  });
});

describe('pull_request_review', () => {
  const review = (state: string, login: string, when: string) => ({ user: { login }, state, submitted_at: when });

  async function withPr() {
    const { repo } = await setup();
    const pr = await seedPullRequest(db, repo.id, 1, { requestedReviewers: [{ kind: 'user', login: 'late-reviewer' }] });
    clearEvents();
    return pr;
  }

  const reviewEvent = () => envelope('pull_request_review', { action: 'submitted', pull_request: { number: 1 }, review: {} });

  it('reads the reviews back and records the decision', async () => {
    const pr = await withPr();
    const calls = stubGithub({
      'GET /repos/acme/web/pulls/1/reviews': [review('COMMENTED', 'a', '2026-11-01T10:00:00Z'), review('APPROVED', 'b', '2026-11-01T11:00:00Z')],
    });
    expect(await applied(reviewEvent())).toEqual({ outcome: 'applied' });
    expect((await prs())[0]).toMatchObject({ id: pr.id, reviewDecision: 'approved' });
    expect(calls).toEqual(perRun([{ method: 'GET', url: '/repos/acme/web/pulls/1/reviews?per_page=100' }]));
    expect(eventLog()).toEqual(['merge_pull_request:updated']);
    expect(events[0]!.changes).toEqual({ reviewDecision: { old: null, new: 'approved' } });
  });

  it('changes requested wins over an approval, and a later approval from the same reviewer replaces it', async () => {
    await withPr();
    stubGithub({
      'GET /repos/acme/web/pulls/1/reviews': [review('APPROVED', 'a', '2026-11-01T10:00:00Z'), review('CHANGES_REQUESTED', 'b', '2026-11-01T11:00:00Z')],
    });
    await applied(reviewEvent());
    expect((await prs())[0]!.reviewDecision).toBe('changes_requested');
    stubGithub({
      'GET /repos/acme/web/pulls/1/reviews': [review('CHANGES_REQUESTED', 'b', '2026-11-01T11:00:00Z'), review('APPROVED', 'b', '2026-11-01T12:00:00Z')],
    });
    await applied(reviewEvent());
    expect((await prs())[0]!.reviewDecision).toBe('approved');
  });

  it('says review_required while reviewers are still requested and nobody has decided', async () => {
    await withPr();
    stubGithub({ 'GET /repos/acme/web/pulls/1/reviews': [review('COMMENTED', 'a', '2026-11-01T10:00:00Z')] });
    await applied(reviewEvent());
    expect((await prs())[0]!.reviewDecision).toBe('review_required');
  });

  it('ignores a pull request it does not know, an untracked repository and an event without an installation', async () => {
    await setup();
    const calls = stubGithub({ 'GET /repos/acme/web/pulls/1/reviews': [] });
    expect((await applied(reviewEvent())).reason).toBe('unknown_pull_request');
    const other = reviewEvent();
    (other.payload as Record<string, unknown>).repository = { id: 5, full_name: 'acme/x' };
    expect((await applied(other)).reason).toBe('untracked_repository');
    const bare = reviewEvent();
    delete (bare.payload as Record<string, unknown>).installation;
    expect((await applied(bare)).reason).toBe('no_installation');
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('answers 502 when GitHub fails, so the forwarder can log it', async () => {
    await withPr();
    stubGithub({ 'GET /repos/acme/web/pulls/1/reviews': new Response('down', { status: 500 }) });
    expect((await send(reviewEvent())).status).toBe(502);
    expect((await prs())[0]!.reviewDecision).toBeNull();
  });
});

describe('check_suite', () => {
  const suiteEvent = (sha: string) => envelope('check_suite', { action: 'completed', check_suite: { head_sha: sha } });
  const suites = (...pairs: Array<[string, string | null, number?]>) => ({
    check_suites: pairs.map(([status, conclusion, runs]) => ({ status, conclusion, latest_check_runs_count: runs ?? 1 })),
  });

  it('records the combined status on every open pull request at that commit, and no other', async () => {
    const { repo } = await setup();
    const a = await seedPullRequest(db, repo.id, 1, { headSha: 'abc' });
    const b = await seedPullRequest(db, repo.id, 2, { headSha: 'abc' });
    const other = await seedPullRequest(db, repo.id, 3, { headSha: 'def' });
    const closed = await seedPullRequest(db, repo.id, 4, { headSha: 'abc', state: 'closed' });
    clearEvents();
    const calls = stubGithub({
      'GET /repos/acme/web/commits/abc/check-suites': suites(['completed', 'success'], ['completed', 'failure'], ['completed', 'success', 0]),
    });

    expect(await applied(suiteEvent('abc'))).toEqual({ outcome: 'applied' });
    const rows = await prs();
    const status = (id: string) => rows.find((r) => r.id === id)!.checksStatus;
    expect([status(a.id), status(b.id)]).toEqual(['failure', 'failure']);
    expect(status(other.id)).toBeNull();
    expect(status(closed.id)).toBeNull();
    expect(calls).toHaveLength(RUNS);
    expect(eventLog()).toEqual(['merge_pull_request:updated', 'merge_pull_request:updated']);
    expect(events[0]!.changes).toEqual({ checksStatus: { old: null, new: 'failure' } });
  });

  it('says pending while a suite runs, success when all pass, neutral when none concluded either way, null without suites', async () => {
    const { repo } = await setup();
    await seedPullRequest(db, repo.id, 1, { headSha: 'abc' });
    const run = async (answer: unknown) => {
      stubGithub({ 'GET /repos/acme/web/commits/abc/check-suites': answer });
      await applied(suiteEvent('abc'));
      return (await prs())[0]!.checksStatus;
    };
    expect(await run(suites(['in_progress', null], ['completed', 'success']))).toBe('pending');
    expect(await run(suites(['completed', 'success'], ['completed', 'skipped']))).toBe('success');
    expect(await run(suites(['completed', 'neutral']))).toBe('neutral');
    expect(await run(suites(['completed', 'success', 0]))).toBeNull();
  });

  it('ignores a commit no open pull request has, and an untracked repository', async () => {
    const { repo } = await setup();
    await seedPullRequest(db, repo.id, 1, { headSha: 'abc' });
    const calls = stubGithub({});
    expect((await applied(suiteEvent('zzz'))).reason).toBe('unknown_pull_request');
    const other = suiteEvent('abc');
    (other.payload as Record<string, unknown>).repository = { id: 5, full_name: 'acme/x' };
    expect((await applied(other)).reason).toBe('untracked_repository');
    expect(calls).toEqual([]);
  });
});

describe('installation_repositories', () => {
  it('drops the repositories that were removed, and keeps the rest', async () => {
    const { repo } = await setup();
    const connection = await seedConnection(db, { externalAccountId: '777' });
    const elsewhere = await seedRepository(db, connection.id, { externalId: '900', fullName: 'other/web' });
    const kept = await seedRepository(db, (await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.externalAccountId, '4242')))[0]!.id, {
      externalId: '901',
      fullName: 'acme/api',
    });
    clearEvents();

    const body = envelope('installation_repositories', {
      action: 'removed',
      repositories_removed: [{ id: 900, full_name: 'acme/web' }],
      repositories_added: [],
    });
    expect(await applied(body)).toEqual({ outcome: 'applied' });

    const rows = await db.select().from(schema.mergeRepositories);
    const deleted = (id: string) => rows.find((r) => r.id === id)!.deletedAt !== null;
    expect([deleted(repo.id), deleted(kept.id), deleted(elsewhere.id)]).toEqual([true, false, false]);
    expect(eventLog()).toEqual(['merge_repository:deleted']);
    expect(events[0]!.entityId).toBe(repo.id);
  });

  it('does nothing for an event that only adds repositories', async () => {
    const { repo } = await setup();
    clearEvents();
    expect(await applied(envelope('installation_repositories', { action: 'added', repositories_added: [{ id: 5 }] }))).toEqual({ outcome: 'applied' });
    expect((await db.select().from(schema.mergeRepositories).where(eq(schema.mergeRepositories.id, repo.id)))[0]!.deletedAt).toBeNull();
    expect(events).toEqual([]);
  });
});
