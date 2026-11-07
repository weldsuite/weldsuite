/**
 * Review and merge on GitLab, Bitbucket and Azure DevOps (phase 4): the same
 * routes, each provider's REST API stubbed by URL and method. Reads use the
 * connection's stored token, writes the member's own.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MergePullRequestFile, MergeReviewResult, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import pullRequestsReviewRoutes from './review';
import { ADMIN, ALICE, VIEWER, errorCode, jsonInit, makeApp, ok, openDb, perRun, resetTables } from '../../test/helpers';
import { seedConnection, seedPullRequest, seedRepository } from '../../test/seed';
import { KEY_ENV, callLines, connectionCredentials, failure, linkAccount, stubProviders } from '../../test/fake-review';
import { failure as httpFailure, stubHttp } from '../../test/fake-http';
import { PROVIDER_ENV } from '../../test/provider-env';
import { sealCredentials } from '../../services/credentials';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE = '/api/merge/pull-requests';
const app = (grants = ADMIN) => makeApp(db, BASE, pullRequestsReviewRoutes, { grants, userId: ALICE, env: KEY_ENV });
const get = (path: string) => app(VIEWER).request(`${BASE}${path}`);
const post = (path: string, body: unknown) => app().request(`${BASE}${path}`, jsonInit(body));

async function seedPull(
  provider: MergeProvider,
  connection: Parameters<typeof seedConnection>[1],
  repository: Parameters<typeof seedRepository>[2],
) {
  const conn = await seedConnection(db, { provider, credentials: await connectionCredentials(), ...connection });
  const repo = await seedRepository(db, conn.id, { provider, ...repository });
  return seedPullRequest(db, repo.id, 7, { provider });
}

describe('GitLab', () => {
  const HOST = 'https://gitlab.example.com';
  const MR = `${HOST}/api/v4/projects/55/merge_requests/7`;
  const seed = () => seedPull('gitlab', { externalAccountId: 'g1', host: HOST }, { externalId: '55', fullName: 'grp/app' });

  it('reads diffs and discussions with the connection token', async () => {
    const pr = await seed();
    const calls = stubProviders({
      [`GET ${MR}/diffs`]: [
        { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1,2 @@\n-a\n+b\n+c' },
        { old_path: 'o.ts', new_path: 'n.ts', renamed_file: true, diff: '' },
        { old_path: 'x.ts', new_path: 'x.ts', new_file: true, diff: '@@ -0,0 +1 @@\n+x' },
      ],
      [`GET ${MR}/discussions`]: [
        {
          id: 'd1',
          notes: [
            { id: 1, body: 'fix', author: { username: 'bob' }, created_at: '2026-11-01T10:00:00Z', resolvable: true, resolved: true, position: { new_path: 'a.ts', old_path: 'a.ts', new_line: 2 } },
            { id: 2, body: 'done', author: { username: 'alice' }, created_at: '2026-11-01T11:00:00Z' },
          ],
        },
        { id: 'd2', notes: [{ id: 3, body: 'merged', system: true, created_at: '2026-11-01T12:00:00Z' }] },
        { id: 'd3', notes: [{ id: 4, body: 'hello', author: { username: 'carol' }, created_at: '2026-11-01T13:00:00Z' }] },
      ],
    });

    const files = (await (await get(`/${pr.id}/files`)).json()) as { data: MergePullRequestFile[] };
    expect(files.data.map((f) => [f.path, f.previousPath, f.status, f.additions, f.deletions])).toEqual([
      ['a.ts', null, 'modified', 2, 1],
      ['n.ts', 'o.ts', 'renamed', 0, 0],
      ['x.ts', null, 'added', 1, 0],
    ]);
    const threads = await ok<MergeReviewThread[]>(await get(`/${pr.id}/threads`));
    expect(threads.map((t) => [t.id, t.path, t.line, t.side, t.resolved, t.comments.length])).toEqual([
      ['d1', 'a.ts', 2, 'RIGHT', true, 2],
      ['d3', null, null, null, false, 1],
    ]);
    // Request by request; in conformance mode the stub answers each request's TypeScript run, then its Rust run.
    expect(callLines(calls)).toEqual([
      ...perRun([`GET ${MR}/diffs?per_page=100&page=1`]),
      ...perRun([`GET ${MR}/discussions?per_page=100&page=1`]),
    ]);
    expect(calls.every((c) => c.authorization === 'Bearer connection-token')).toBe(true);
  });

  it('approves as the member, posts the comment as a discussion, and squashes', async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'gitlab', { host: HOST, token: 'glpat-alice' });
    const calls = stubProviders({
      [`POST ${MR}/approve`]: {},
      [`POST ${MR}/discussions`]: { id: 'dx', notes: [{ id: 9, body: 'ok', created_at: '2026-11-02T10:00:00Z' }] },
      [`PUT ${MR}/merge`]: { state: 'merged' },
    });

    await ok<MergeReviewResult>(await post(`/${pr.id}/reviews`, { event: 'approve', body: 'ok' }));
    await ok<MergeReviewResult>(await post(`/${pr.id}/merge`, { method: 'squash', commitTitle: 'T', commitMessage: 'M' }));

    // The writes, as the member (the reads that refresh the mirror afterwards use the connection token).
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [c.method, c.url.replace(HOST, ''), c.authorization, c.body])).toEqual([
      ...perRun([
        ['POST', '/api/v4/projects/55/merge_requests/7/approve', 'Bearer glpat-alice', null],
        ['POST', '/api/v4/projects/55/merge_requests/7/discussions', 'Bearer glpat-alice', { body: 'ok' }],
      ]),
      ...perRun([['PUT', '/api/v4/projects/55/merge_requests/7/merge', 'Bearer glpat-alice', { squash: true, squash_commit_message: 'T\n\nM' }]]),
    ]);
  });

  it('rebases first, then merges; 406 from GitLab is not_mergeable', async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'gitlab', { host: HOST });
    const calls = stubProviders({
      [`PUT ${MR}/rebase`]: {},
      [`GET ${MR}`]: { rebase_in_progress: false },
      [`PUT ${MR}/merge`]: failure(406, 'Branch cannot be merged'),
    });
    const res = await post(`/${pr.id}/merge`, { method: 'rebase' });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_mergeable');
    expect(callLines(calls).map((l) => l.replace(HOST, ''))).toEqual(
      perRun([
        'PUT /api/v4/projects/55/merge_requests/7/rebase',
        'GET /api/v4/projects/55/merge_requests/7?include_rebase_in_progress=true',
        'PUT /api/v4/projects/55/merge_requests/7/merge',
      ]),
    );
  });

  it('puts a line comment at the diff position of the current head, and replies in a discussion', async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'gitlab', { host: HOST });
    const calls = stubProviders({
      [`GET ${MR}`]: { diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } },
      [`POST ${MR}/discussions`]: { id: 'dn', notes: [{ id: 10, body: 'x', created_at: '2026-11-02T10:00:00Z' }] },
      [`POST ${MR}/discussions/d1/notes`]: { id: 11, body: 'y', created_at: '2026-11-02T10:01:00Z' },
    });
    const line = await ok<{ threadId: string }>(await post(`/${pr.id}/comments`, { body: 'x', path: 'a.ts', line: 3 }), 201);
    const reply = await ok<{ threadId: string }>(await post(`/${pr.id}/comments`, { body: 'y', inReplyToId: 'd1' }), 201);
    expect([line.threadId, reply.threadId]).toEqual(['dn', 'd1']);
    expect(calls.find((c) => c.url.endsWith('/discussions'))!.body).toEqual({
      body: 'x',
      position: { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'a.ts', old_path: 'a.ts', new_line: 3 },
    });
  });

  it('is account_not_linked without a verified account for that host', async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'gitlab', { host: 'https://other.example.com' });
    expect(await errorCode(await post(`/${pr.id}/reviews`, { event: 'approve' }))).toBe('account_not_linked');
  });
});

describe('Bitbucket', () => {
  const PR = 'https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests/7';
  const seed = () => seedPull('bitbucket', { externalAccountId: 'bb1' }, { externalId: '{r1}', fullName: 'acme/web', externalProject: 'acme' });

  it('reads the diffstat with per-file patches and threads with inline anchors', async () => {
    const pr = await seed();
    stubProviders({
      [`GET ${PR}/diffstat`]: {
        values: [
          { status: 'modified', lines_added: 1, lines_removed: 1, old: { path: 'a.ts' }, new: { path: 'a.ts' } },
          { status: 'added', lines_added: 2, lines_removed: 0, new: { path: 'b.ts' } },
        ],
      },
      [`GET ${PR}/diff`]:
        'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n',
      [`GET ${PR}/comments`]: {
        values: [
          { id: 2, content: { raw: 'reply' }, user: { nickname: 'alice' }, created_on: '2026-11-01T11:00:00Z', parent: { id: 1 } },
          { id: 1, content: { raw: 'rename' }, user: { nickname: 'bob' }, created_on: '2026-11-01T10:00:00Z', inline: { path: 'a.ts', from: null, to: 5 } },
          { id: 3, content: { raw: 'gone' }, created_on: '2026-11-01T12:00:00Z', deleted: true },
        ],
      },
    });
    const files = (await (await get(`/${pr.id}/files`)).json()) as { data: MergePullRequestFile[] };
    expect(files.data[0]).toMatchObject({ path: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' });
    expect(files.data[1]).toMatchObject({ path: 'b.ts', status: 'added', additions: 2, patch: '@@ -0,0 +1,2 @@\n+x\n+y' });
    const threads = await ok<MergeReviewThread[]>(await get(`/${pr.id}/threads`));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: '1', path: 'a.ts', line: 5, side: 'RIGHT' });
    expect(threads[0]!.comments.map((c) => c.body)).toEqual(['rename', 'reply']);
  });

  it('requests changes with a comment, and merges with the chosen strategy; a 400 refusal is not_mergeable', async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'bitbucket', { token: 'bb-alice' });
    const calls = stubProviders({
      [`POST ${PR}/comments`]: { id: 8, content: { raw: 'please fix' }, created_on: '2026-11-02T10:00:00Z' },
      [`POST ${PR}/request-changes`]: {},
      [`POST ${PR}/merge`]: failure(400, 'You must resolve merge conflicts'),
    });
    await ok<MergeReviewResult>(await post(`/${pr.id}/reviews`, { event: 'request_changes', body: 'please fix' }));
    // The writes; the reads that refresh the mirror and the review decision follow them.
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url.replace(PR, ''), c.body])).toEqual(
      perRun([
        ['POST', '/comments', { content: { raw: 'please fix' } }],
        ['POST', '/request-changes', null],
      ]),
    );

    const res = await post(`/${pr.id}/merge`, { method: 'rebase' });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_mergeable');
    expect(calls.at(-1)).toMatchObject({ authorization: 'Bearer bb-alice', body: { type: 'pullrequest', merge_strategy: 'rebase_fast_forward' } });
  });
});

describe('Azure DevOps', () => {
  const ORG = 'https://dev.azure.com/acme';
  const PR = `${ORG}/Proj/_apis/git/repositories/repo-1/pullrequests/7`;
  const seed = () => seedPull('azure_devops', { externalAccountId: 'az1', host: ORG }, { externalId: 'repo-1', fullName: 'Proj/web', externalProject: 'Proj' });

  it('reads the last iteration changes and threads, skipping system comments', async () => {
    const pr = await seed();
    stubProviders({
      [`GET ${PR}/iterations`]: { value: [{ id: 1 }, { id: 2 }] },
      [`GET ${PR}/iterations/2/changes`]: {
        changeEntries: [
          { changeType: 'edit', item: { path: '/src/a.ts' } },
          { changeType: 'rename', item: { path: '/src/n.ts' }, originalPath: '/src/o.ts' },
        ],
      },
      [`GET ${PR}/threads`]: {
        value: [
          { id: 4, status: 'fixed', threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 12 } }, comments: [{ id: 1, content: 'nit', commentType: 'text', publishedDate: '2026-11-01T10:00:00Z', author: { uniqueName: 'bob@acme.io' } }] },
          { id: 5, comments: [{ id: 1, content: 'Policy', commentType: 'system', publishedDate: '2026-11-01T10:00:00Z' }] },
        ],
      },
    });
    const files = (await (await get(`/${pr.id}/files`)).json()) as { data: MergePullRequestFile[] };
    expect(files.data.map((f) => [f.path, f.previousPath, f.status, f.patch])).toEqual([
      ['src/a.ts', null, 'modified', null],
      ['src/n.ts', 'src/o.ts', 'renamed', null],
    ]);
    const threads = await ok<MergeReviewThread[]>(await get(`/${pr.id}/threads`));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: '4', path: 'src/a.ts', line: 12, side: 'RIGHT', resolved: true });
  });

  it('votes as the member and completes the pull request with the strategy', async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'azure_devops', { host: ORG, token: 'entra-alice' });
    const calls = stubProviders({
      [`GET ${ORG}/_apis/connectionData`]: { authenticatedUser: { id: 'user-guid' } },
      [`PUT ${PR}/reviewers/user-guid`]: {},
      [`GET ${PR}`]: { status: 'active', lastMergeSourceCommit: { commitId: 'c1' } },
      [`PATCH ${PR}`]: { status: 'completed' },
    });
    await ok<MergeReviewResult>(await post(`/${pr.id}/reviews`, { event: 'approve' }));
    await ok<MergeReviewResult>(await post(`/${pr.id}/merge`, { method: 'rebase', commitMessage: 'msg' }));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ body: { vote: 10 }, authorization: 'Bearer entra-alice' });
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: 'c1' },
      completionOptions: { mergeStrategy: 'rebase', mergeCommitMessage: 'msg' },
    });
  });

  it('a conflicting completion is not_mergeable with the provider message', async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'azure_devops', { host: ORG });
    stubProviders({
      [`GET ${PR}`]: { lastMergeSourceCommit: { commitId: 'c1' } },
      [`PATCH ${PR}`]: { status: 'active', mergeStatus: 'conflicts', mergeFailureMessage: 'Merge conflicts' },
    });
    const res = await post(`/${pr.id}/merge`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: 'not_mergeable',
      message: 'Merge conflicts',
    });
  });
});

describe('a token refresh that races another request (GitLab rotates refresh tokens)', () => {
  const HOST = 'gitlab.example.com';
  const MR = `${HOST}/api/v4/projects/55/merge_requests/7`;
  const TOKEN = `POST ${HOST}/oauth/token`;
  const oauthApp = () => makeApp(db, BASE, pullRequestsReviewRoutes, { grants: ADMIN, userId: ALICE, env: PROVIDER_ENV });
  const approve = (id: string) => oauthApp().request(`${BASE}/${id}/reviews`, jsonInit({ event: 'approve' }));
  const sealed = (accessToken: string, refreshToken: string, minutes: number) =>
    sealCredentials(KEY_ENV, { accessToken, refreshToken, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() });
  const seed = (credentials?: string) =>
    seedPull(
      'gitlab',
      { externalAccountId: 'g1', host: `https://${HOST}`, ...(credentials ? { credentials } : {}) },
      { externalId: '55', fullName: 'grp/app' },
    );
  const refused = () => httpFailure(400, { error: 'invalid_grant' });

  it("uses the member token the other request stored, and keeps the link, when this request's refresh is refused", async () => {
    const pr = await seed();
    await linkAccount(db, ALICE, 'gitlab', { host: `https://${HOST}` });
    await db.update(schema.mergeProviderAccounts).set({ credentials: await sealed('alice-old', 'ar1', 1) });
    const winner = await sealed('alice-winner', 'ar2', 120);
    const calls = stubHttp({
      // The other request rotated ar1 first and stored its credentials; GitLab refuses this one.
      [TOKEN]: async () => {
        await db.update(schema.mergeProviderAccounts).set({ credentials: winner });
        return refused();
      },
      [`POST ${MR}/approve`]: {},
    });

    await ok<MergeReviewResult>(await approve(pr.id));
    expect(calls.filter((c) => c.url === `${MR}/approve`).map((c) => c.auth)).toEqual(perRun(['bearer alice-winner']));
    const [account] = await db.select().from(schema.mergeProviderAccounts);
    expect(account).toMatchObject({ credentials: winner });
    expect(account!.verifiedAt).not.toBeNull();
  });

  it("uses the connection token the other request stored, and stays active, when this request's refresh is refused", async () => {
    const pr = await seed(await sealed('conn-old', 'cr1', 1));
    await linkAccount(db, ALICE, 'gitlab', { host: `https://${HOST}`, token: 'glpat-alice' });
    const winner = await sealed('conn-winner', 'cr2', 120);
    const calls = stubHttp({
      [TOKEN]: async () => {
        await db.update(schema.mergeConnections).set({ credentials: winner });
        return refused();
      },
      [`POST ${MR}/approve`]: {},
    });

    await ok<MergeReviewResult>(await approve(pr.id));
    // The mirror is re-read after the review with the connection token: the one the other request stored.
    const reads = calls.filter((c) => c.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.auth === 'bearer conn-winner')).toBe(true);
    const [connection] = await db.select().from(schema.mergeConnections);
    expect(connection).toMatchObject({ status: 'active', credentials: winner });
  });
});
