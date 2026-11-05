/**
 * Review and merge on GitHub (phase 4), on a real tenant schema (pglite) with
 * GitHub's REST API stubbed by URL and method. What must not regress:
 *   1. Files and threads are read live with the installation token and
 *      normalized (a reply joins its root's thread; issue comments are general).
 *   2. Reviews, comments and merges act as the member: their own token goes out,
 *      and a member without a linked, verified account gets 409 account_not_linked
 *      before anything is sent.
 *   3. After a review or merge the mirror is re-fetched and saved the way a
 *      webhook would be (merged state, `merge_pull_request.merged`, automations).
 *   4. A provider refusal is 502 provider_error with its message; an unmergeable
 *      pull request is 409 not_mergeable.
 *   5. Permissions (403), validation (400) and unknown ids (404).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MergePullRequestFile, MergeReviewResult, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import pullRequestsReviewRoutes from './review';
import { ADMIN, ALICE, VIEWER, clearEvents, errorCode, eventTypes, githubPull, jsonInit, makeApp, ok, openDb, perRun, resetTables } from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';
import { KEY_ENV, callLines, failure, linkAccount, stubProviders } from '../../test/fake-review';

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

const BASE = '/api/merge/pull-requests';
const GH = 'https://api.github.com';
const app = (grants = ADMIN, userId = ALICE) => makeApp(db, BASE, pullRequestsReviewRoutes, { grants, userId, env: KEY_ENV });

async function seedGithubPull(overrides: Parameters<typeof seedPullRequest>[3] = {}) {
  const connection = await seedConnection(db);
  const repository = await seedRepository(db, connection.id);
  return seedPullRequest(db, repository.id, 7, overrides);
}

const get = (path: string, grants = VIEWER) => app(grants).request(`${BASE}${path}`);
const post = (path: string, body: unknown, grants = ADMIN) => app(grants).request(`${BASE}${path}`, jsonInit(body));

describe('files and threads (connection token)', () => {
  it('lists the changed files, normalized, with the installation token', async () => {
    const pr = await seedGithubPull();
    const calls = stubProviders({
      [`GET ${GH}/repos/acme/web/pulls/7/files`]: [
        { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 },
        { filename: 'img.png', status: 'unchanged', additions: 0, deletions: 0 },
      ],
    });

    const res = await get(`/${pr.id}/files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: MergePullRequestFile[]; pagination: { hasMore: boolean } };
    expect(body.pagination.hasMore).toBe(false);
    expect(body.data).toEqual([
      { path: 'src/a.ts', previousPath: null, status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null },
      { path: 'img.png', previousPath: null, status: 'changed', additions: 0, deletions: 0, patch: null },
    ]);
    expect(callLines(calls)).toEqual(perRun([`GET ${GH}/repos/acme/web/pulls/7/files?per_page=100&page=1`]));
    expect(calls[0]!.authorization).toBe('Bearer ghs_test_token');
  });

  it('groups review comments into threads and lists conversation comments as general', async () => {
    const pr = await seedGithubPull();
    stubProviders({
      [`GET ${GH}/repos/acme/web/pulls/7/comments`]: [
        { id: 12, body: 'Why?', user: { login: 'bob', avatar_url: 'a' }, created_at: '2026-11-01T11:00:00Z', path: 'src/a.ts', line: 4, side: 'RIGHT', in_reply_to_id: 11, html_url: 'u12' },
        { id: 11, body: 'Rename this', user: { login: 'alice-gh', avatar_url: null }, created_at: '2026-11-01T10:00:00Z', path: 'src/a.ts', line: 4, side: 'RIGHT', html_url: 'u11' },
      ],
      [`GET ${GH}/repos/acme/web/issues/7/comments`]: [
        { id: 30, body: 'LGTM overall', user: { login: 'carol' }, created_at: '2026-11-01T12:00:00Z', html_url: 'u30' },
      ],
    });

    const threads = await ok<MergeReviewThread[]>(await get(`/${pr.id}/threads`));
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({ id: '11', path: 'src/a.ts', line: 4, side: 'RIGHT', resolved: false });
    expect(threads[0]!.comments.map((c) => [c.id, c.body, c.author?.login])).toEqual([
      ['11', 'Rename this', 'alice-gh'],
      ['12', 'Why?', 'bob'],
    ]);
    expect(threads[1]).toMatchObject({ id: 'issue-30', path: null, line: null, side: null });
    expect(threads[1]!.comments[0]).toMatchObject({ body: 'LGTM overall', author: { login: 'carol', avatarUrl: null } });
  });

  it('answers 404 for an unknown pull request and 403 without merge_pull_requests:read', async () => {
    expect((await get('/mpr_missing/files')).status).toBe(404);
    const pr = await seedGithubPull();
    expect((await get(`/${pr.id}/threads`, [])).status).toBe(403);
  });

  it('passes a GitHub failure on as 502 provider_error', async () => {
    const pr = await seedGithubPull();
    stubProviders({ [`GET ${GH}/repos/acme/web/pulls/7/files`]: failure(500, 'boom') });
    const res = await get(`/${pr.id}/files`);
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('provider_error');
  });
});

describe('reviews (as the member)', () => {
  it('refuses without a linked, verified account and sends nothing', async () => {
    const pr = await seedGithubPull();
    const calls = stubProviders({});
    let res = await post(`/${pr.id}/reviews`, { event: 'approve' });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('account_not_linked');

    await linkAccount(db, ALICE, 'github', { verified: false });
    res = await post(`/${pr.id}/reviews`, { event: 'approve' });
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('approves with the member token, then re-reads the mirror and the review decision', async () => {
    const pr = await seedGithubPull({ reviewDecision: 'review_required' });
    await linkAccount(db, ALICE, 'github', { token: 'gho_alice' });
    const calls = stubProviders({
      [`POST ${GH}/repos/acme/web/pulls/7/reviews`]: { id: 1 },
      [`GET ${GH}/repos/acme/web/pulls/7`]: githubPull({ id: 5007, number: 7, title: 'Pull request 7', updatedAt: '2026-11-02T10:00:00Z' }),
      [`GET ${GH}/repos/acme/web/pulls/7/reviews`]: [{ state: 'APPROVED', user: { login: 'alice-gh' }, submitted_at: '2026-11-02T10:00:00Z' }],
    });

    const result = await ok<MergeReviewResult>(
      await post(`/${pr.id}/reviews`, {
        event: 'approve',
        body: 'Looks good',
        comments: [{ path: 'src/a.ts', line: 4, body: 'nit', side: 'LEFT' }, { path: 'src/b.ts', line: 9, body: 'ok' }],
      }),
    );

    const review = calls.find((c) => c.method === 'POST')!;
    expect(review.authorization).toBe('Bearer gho_alice');
    expect(review.body).toEqual({
      event: 'APPROVE',
      body: 'Looks good',
      comments: [
        { path: 'src/a.ts', line: 4, side: 'LEFT', body: 'nit' },
        { path: 'src/b.ts', line: 9, side: 'RIGHT', body: 'ok' },
      ],
    });
    expect(result.pullRequest.id).toBe(pr.id);
    expect(result.pullRequest.reviewDecision).toBe('approved');
    const [row] = await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.id, pr.id));
    expect(row?.reviewDecision).toBe('approved');
    expect(eventTypes()).toContain('merge_pull_request:updated');
  });

  it('request_changes needs a comment; an approval needs none', async () => {
    const pr = await seedGithubPull();
    expect((await post(`/${pr.id}/reviews`, { event: 'request_changes' })).status).toBe(400);
    expect((await post(`/${pr.id}/reviews`, { event: 'bogus' })).status).toBe(400);
  });

  it('needs merge_pull_requests:review', async () => {
    const pr = await seedGithubPull();
    expect((await post(`/${pr.id}/reviews`, { event: 'approve' }, VIEWER)).status).toBe(403);
    expect((await post('/mpr_missing/reviews', { event: 'approve' })).status).toBe(404);
  });

  it('passes GitHub refusals on as 502 provider_error with its message', async () => {
    const pr = await seedGithubPull();
    await linkAccount(db, ALICE, 'github');
    stubProviders({ [`POST ${GH}/repos/acme/web/pulls/7/reviews`]: failure(422, 'Can not approve your own pull request') });
    const res = await post(`/${pr.id}/reviews`, { event: 'approve' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'provider_error', message: 'Can not approve your own pull request' });
  });
});

describe('comments (as the member)', () => {
  it('posts a general comment on the issue, a reply, and a line comment on the head commit', async () => {
    const pr = await seedGithubPull();
    await linkAccount(db, ALICE, 'github', { token: 'gho_alice' });
    const calls = stubProviders({
      [`POST ${GH}/repos/acme/web/issues/7/comments`]: { id: 40, body: 'hello', user: { login: 'alice-gh' }, created_at: '2026-11-02T10:00:00Z' },
      [`GET ${GH}/repos/acme/web/pulls/7`]: { head: { sha: 'headsha7' } },
      [`POST ${GH}/repos/acme/web/pulls/7/comments`]: (call: { body: unknown }) => ({
        id: 41,
        body: (call.body as { body: string }).body,
        user: { login: 'alice-gh' },
        created_at: '2026-11-02T10:01:00Z',
        in_reply_to_id: (call.body as { in_reply_to?: number }).in_reply_to ?? null,
      }),
    });

    const general = await ok<{ comment: { id: string }; threadId: string | null }>(await post(`/${pr.id}/comments`, { body: 'hello' }), 201);
    expect(general).toMatchObject({ comment: { id: '40' }, threadId: 'issue-40' });

    const reply = await ok<{ threadId: string | null }>(await post(`/${pr.id}/comments`, { body: 'agreed', inReplyToId: '11' }), 201);
    expect(reply.threadId).toBe('11');

    const line = await ok<{ threadId: string | null }>(await post(`/${pr.id}/comments`, { body: 'here', path: 'src/a.ts', line: 4 }), 201);
    expect(line.threadId).toBe('41');

    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.body);
    // Request by request; in conformance mode each request runs on TypeScript, then on Rust.
    expect(posts).toEqual([
      ...perRun([{ body: 'hello' }]),
      ...perRun([{ body: 'agreed', in_reply_to: 11 }]),
      ...perRun([{ body: 'here', commit_id: 'headsha7', path: 'src/a.ts', line: 4, side: 'RIGHT' }]),
    ]);
    expect(calls.every((c) => c.authorization === 'Bearer gho_alice')).toBe(true);
  });

  it('rejects a line comment without both path and line, and an empty body', async () => {
    const pr = await seedGithubPull();
    expect((await post(`/${pr.id}/comments`, { body: 'x', path: 'a.ts' })).status).toBe(400);
    expect((await post(`/${pr.id}/comments`, { body: '  ' })).status).toBe(400);
    expect((await post(`/${pr.id}/comments`, { body: 'x' }, VIEWER)).status).toBe(403);
  });
});

describe('merge (as the member)', () => {
  it('merges, re-fetches the mirror and runs the automation for a linked issue', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await seedIssue(db, team.id, 1, { status: 'in_review' });
    const pr = await seedGithubPull({ title: 'Fix it', body: 'Closes PLAT-1', headRef: 'feature/7' });
    await linkAccount(db, ALICE, 'github', { token: 'gho_alice' });
    clearEvents();
    const calls = stubProviders({
      [`PUT ${GH}/repos/acme/web/pulls/7/merge`]: { merged: true, sha: 'abc' },
      [`GET ${GH}/repos/acme/web/pulls/7`]: githubPull({ id: 5007, number: 7, title: 'Fix it', body: 'Closes PLAT-1', merged: true, state: 'closed', updatedAt: '2026-11-02T10:00:00Z' }),
    });

    const result = await ok<MergeReviewResult>(
      await post(`/${pr.id}/merge`, { method: 'squash', commitTitle: 'Fix it (#7)', commitMessage: 'details' }),
    );

    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      authorization: 'Bearer gho_alice',
      body: { merge_method: 'squash', commit_title: 'Fix it (#7)', commit_message: 'details' },
    });
    expect(callLines(calls)).toEqual(perRun([`PUT ${GH}/repos/acme/web/pulls/7/merge`, `GET ${GH}/repos/acme/web/pulls/7`]));
    expect(result.pullRequest.state).toBe('merged');
    expect(eventTypes()).toContain('merge_pull_request:merged');
    const [moved] = await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, issue.id));
    expect(moved?.status).toBe('done');
  });

  it('defaults to a merge commit', async () => {
    const pr = await seedGithubPull();
    await linkAccount(db, ALICE, 'github');
    const calls = stubProviders({ [`PUT ${GH}/repos/acme/web/pulls/7/merge`]: { merged: true } });
    await ok<MergeReviewResult>(await post(`/${pr.id}/merge`, {}));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ merge_method: 'merge' });
  });

  it('answers 409 not_mergeable when GitHub refuses on the merits, 502 for other failures', async () => {
    const pr = await seedGithubPull();
    await linkAccount(db, ALICE, 'github');
    stubProviders({ [`PUT ${GH}/repos/acme/web/pulls/7/merge`]: failure(405, 'Pull Request is not mergeable') });
    let res = await post(`/${pr.id}/merge`, {});
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_mergeable');

    stubProviders({ [`PUT ${GH}/repos/acme/web/pulls/7/merge`]: failure(403, 'Resource not accessible') });
    res = await post(`/${pr.id}/merge`, {});
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('provider_error');
  });

  it('does not call the provider for a pull request that is no longer open', async () => {
    const pr = await seedGithubPull({ state: 'merged', mergedAt: new Date('2026-11-01T10:00:00Z') });
    await linkAccount(db, ALICE, 'github');
    const calls = stubProviders({});
    const res = await post(`/${pr.id}/merge`, {});
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_mergeable');
    expect(calls).toEqual([]);
  });

  it('refuses without a linked account (409), without the permission (403), on bad input (400) and for an unknown id (404)', async () => {
    const pr = await seedGithubPull();
    expect(await errorCode(await post(`/${pr.id}/merge`, {}))).toBe('account_not_linked');
    expect((await post(`/${pr.id}/merge`, {}, VIEWER)).status).toBe(403);
    expect((await post(`/${pr.id}/merge`, { method: 'fast-forward' })).status).toBe(400);
    expect((await post('/mpr_missing/merge', {})).status).toBe(404);
  });
});
