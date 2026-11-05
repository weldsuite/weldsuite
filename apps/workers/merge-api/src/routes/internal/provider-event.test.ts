/**
 * DB-backed tests for the GitLab, Bitbucket and Azure DevOps event intake
 * (POST /internal/provider-event, what `MergeInternal.providerEvent` calls) on
 * a real tenant schema (pglite), with every provider API stubbed by method and
 * URL. What must not regress:
 *   1. A delivery is applied only when its repository is known by the key in
 *      the URL and its signature (GitLab token, Bitbucket HMAC, Azure basic
 *      auth password) matches the repository's own stored secret.
 *   2. Pull requests are mirrored through the same sync and automation as
 *      GitHub's (links by key, one move per phase change, system events), a
 *      copy older than the stored one and a repository with pr_sync off are
 *      ignored.
 *   3. A hook that only says "something changed" (an approval, a build) is
 *      completed by a read from the provider; a provider that fails that read
 *      leaves the mirror as it was.
 *   4. GitLab issues and notes flow into WeldMerge for a repository whose
 *      issue_sync is import or two_way, and nowhere else.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import internalRoutes from './index';
import { sealCredentials } from '../../services/credentials';
import { ADMIN, clearEvents, data, events, jsonInit, makeApp, openDb, resetTables } from '../../test/helpers';
import { failure, stubHttp } from '../../test/fake-http';
import { azurePr, azurePrHook, AZURE_REPO } from '../../test/fake-azure-devops';
import { bitbucketPr, bitbucketPrHook } from '../../test/fake-bitbucket';
import { gitlabIssue, gitlabMr, gitlabMrHook } from '../../test/fake-gitlab';
import { ENCRYPTION_KEY, PROVIDER_ENV, providerEnv } from '../../test/provider-env';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';
import type { Env } from '../../types';

let db: Database;
const sealEnv = PROVIDER_ENV as unknown as Env;
const KEYRING = keyringFromEnv({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY });

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PATH = '/internal/provider-event';
const internal = () => makeApp(db, '/internal', internalRoutes, { grants: ADMIN, env: providerEnv() });

type Provider = 'gitlab' | 'bitbucket' | 'azure_devops';

async function send(provider: Provider, key: string, headers: Record<string, string>, body: unknown) {
  const res = await internal().request(
    PATH,
    jsonInit({ workspaceId: 'org_alpha', provider, key, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  );
  expect(res.status).toBe(200);
  return data<{ outcome: string; reason?: string }>(res);
}

interface Setup {
  repo: typeof schema.mergeRepositories.$inferSelect;
  key: string;
  secret: string;
}

async function setup(
  provider: Provider,
  repoOverrides: Partial<typeof schema.mergeRepositories.$inferInsert> = {},
  connectionOverrides: Partial<typeof schema.mergeConnections.$inferInsert> = {},
): Promise<Setup> {
  const key = `${provider}-key`.padEnd(40, 'k');
  const secret = `${provider}-secret`;
  const connection = await seedConnection(db, {
    provider,
    externalAccountId: `acct-${provider}`,
    credentials: await sealCredentials(sealEnv, { accessToken: `${provider}-token` }),
    ...connectionOverrides,
  });
  const repo = await seedRepository(db, connection.id, {
    provider,
    webhookKey: key,
    webhookId: 'hook-1',
    webhookSecret: await encryptField(secret, KEYRING),
    ...repoOverrides,
  });
  clearEvents();
  return { repo, key, secret };
}

const prs = () => db.select().from(schema.mergePullRequests);
const eventLog = () => events.map((e) => e.eventType);
const issueOf = async (id: string) => (await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, id)))[0]!;

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

describe('GitLab', () => {
  const gl = (secret: string) => ({ 'x-gitlab-token': secret });

  async function gitlabSetup(repoOverrides: Partial<typeof schema.mergeRepositories.$inferInsert> = {}) {
    const team = await seedTeam(db, 'PLAT');
    const one = await seedIssue(db, team.id, 1, { status: 'todo' });
    const s = await setup('gitlab', { externalId: '55', fullName: 'acme/web', teamId: team.id, ...repoOverrides });
    return { ...s, team, one };
  }

  it('ignores an unknown key, a wrong token and an unreadable body', async () => {
    const { key } = await gitlabSetup();
    expect(await send('gitlab', 'nope', gl('x'), gitlabMrHook({ iid: 1, action: 'open' }))).toEqual({ outcome: 'ignored', reason: 'unknown_repository' });
    expect(await send('gitlab', key, gl('wrong'), gitlabMrHook({ iid: 1, action: 'open' }))).toEqual({ outcome: 'ignored', reason: 'bad_signature' });
    expect(await send('gitlab', key, {}, gitlabMrHook({ iid: 1, action: 'open' }))).toEqual({ outcome: 'ignored', reason: 'bad_signature' });
    expect(await send('gitlab', key, gl('gitlab-secret'), '{not json')).toEqual({ outcome: 'ignored', reason: 'invalid_body' });
    expect(await prs()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('ignores a key of another provider, and a repository whose project the hook does not name', async () => {
    const { key, secret } = await gitlabSetup();
    expect(await send('bitbucket', key, gl(secret), {})).toEqual({ outcome: 'ignored', reason: 'unknown_repository' });
    expect(await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 1, action: 'open', projectId: 999 }))).toEqual({ outcome: 'ignored', reason: 'no_event' });
  });

  it('mirrors an opened draft merge request, links PLAT-1 from the branch, and moves the issue once', async () => {
    const { key, secret, one } = await gitlabSetup();
    const calls = stubHttp({});
    const result = await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 1, action: 'open', source: 'plat-1-fix-tabs', draft: true, actor: 'Octo-Dev' }));
    expect(result).toEqual({ outcome: 'applied' });
    expect(calls).toEqual([]);

    const [pr] = await prs();
    expect(pr).toMatchObject({ provider: 'gitlab', externalId: '7001', number: 1, state: 'open', draft: true, authorLogin: 'octo-dev', headRef: 'plat-1-fix-tabs', headSha: 'sha1' });
    expect((await issueOf(one.id)).status).toBe('in_progress');
    expect(eventLog()).toEqual(['merge_pull_request:created', 'merge_issue:updated']);
    expect(events.every((e) => e.metadata.source === 'system' && e.metadata.userId === 'system')).toBe(true);

    // The same copy again moves nothing.
    clearEvents();
    await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 1, action: 'update', source: 'plat-1-fix-tabs', draft: true }));
    expect((await issueOf(one.id)).status).toBe('in_progress');
  });

  it('completes the author from GitLab when the hook names only the actor, and closes the issue on merge', async () => {
    const { key, secret, one } = await gitlabSetup();
    await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 1, action: 'open', source: 'plat-1-fix-tabs', updatedAt: '2026-11-02T09:00:00.000Z' }));
    clearEvents();

    const calls = stubHttp({
      'GET gitlab.com/api/v4/projects/55/merge_requests/1': gitlabMr({ iid: 1, source: 'plat-1-fix-tabs', state: 'merged', author: 'Octo-Dev', updatedAt: '2026-11-02T10:00:00.000Z' }),
    });
    const result = await send(
      'gitlab',
      key,
      gl(secret),
      gitlabMrHook({ iid: 1, action: 'merge', state: 'merged', source: 'plat-1-fix-tabs', actor: 'Merge-Bot', updatedAt: '2026-11-02T10:00:00.000Z' }),
    );
    expect(result).toEqual({ outcome: 'applied' });
    expect(calls).toEqual([{ method: 'GET', url: 'gitlab.com/api/v4/projects/55/merge_requests/1', auth: 'bearer gitlab-token' }]);
    const [pr] = await prs();
    expect(pr).toMatchObject({ state: 'merged', authorLogin: 'octo-dev' });
    expect((await issueOf(one.id)).status).toBe('done');
    expect(eventLog()).toEqual(['merge_pull_request:updated', 'merge_pull_request:merged', 'merge_issue:updated']);
  });

  it('keeps the hook\'s copy when GitLab cannot be read to complete it', async () => {
    const { key, secret } = await gitlabSetup();
    stubHttp({ 'GET gitlab.com/api/v4/projects/55/merge_requests/3': failure(500) });
    const result = await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 3, action: 'update', actor: 'Someone' }));
    expect(result).toEqual({ outcome: 'applied' });
    expect((await prs())[0]).toMatchObject({ number: 3, authorLogin: null });
  });

  it('ignores a copy older than the stored one and a repository with pr_sync off', async () => {
    const { key, secret, repo } = await gitlabSetup();
    await seedPullRequest(db, repo.id, 5, { provider: 'gitlab', providerUpdatedAt: new Date('2026-11-03T00:00:00Z') });
    stubHttp({});
    expect(await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 5, action: 'open', updatedAt: '2026-11-01T00:00:00.000Z' }))).toEqual({ outcome: 'ignored', reason: 'stale' });
    await db.update(schema.mergeRepositories).set({ prSync: false }).where(eq(schema.mergeRepositories.id, repo.id));
    expect(await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 6, action: 'open' }))).toEqual({ outcome: 'ignored', reason: 'pr_sync_off' });
  });

  it('reads the approvals back after an approval and records the decision', async () => {
    const { key, secret, repo } = await gitlabSetup();
    await seedPullRequest(db, repo.id, 1, { provider: 'gitlab', externalId: '7001', providerUpdatedAt: new Date('2026-11-01T10:00:00Z') });
    const calls = stubHttp({
      'GET gitlab.com/api/v4/projects/55/merge_requests/1': gitlabMr({ iid: 1, updatedAt: '2026-11-01T10:00:00.000Z' }),
      'GET gitlab.com/api/v4/projects/55/merge_requests/1/approvals': { approved: true, approved_by: [{ user: { username: 'Reviewer-One' } }], approvals_left: 0 },
    });
    const result = await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 1, action: 'approved', updatedAt: '2026-11-01T10:00:00.000Z' }));
    expect(result).toEqual({ outcome: 'applied' });
    expect((await prs())[0]!.reviewDecision).toBe('approved');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('GET gitlab.com/api/v4/projects/55/merge_requests/1/approvals');
    expect(events.find((e) => e.eventType === 'merge_pull_request:updated' && e.changes && 'reviewDecision' in e.changes)).toBeDefined();
  });

  it('leaves the review decision alone when GitLab fails the read', async () => {
    const { key, secret, repo } = await gitlabSetup();
    await seedPullRequest(db, repo.id, 1, { provider: 'gitlab', reviewDecision: 'review_required' });
    stubHttp({ 'GET gitlab.com/api/v4/projects/55/merge_requests/1': failure(502) });
    const result = await send('gitlab', key, gl(secret), {
      object_kind: 'merge_request',
      user: { username: 'x' },
      project: { id: 55 },
      object_attributes: { id: 7001, iid: 1, title: 't', state: 'opened', action: 'approved', url: 'https://gitlab.com/acme/web/-/merge_requests/1', updated_at: '2026-10-01 00:00:00 UTC' },
    });
    // The pull request copy is stale (older), the approval re-read fails: nothing is recorded.
    expect(result.outcome).toBe('ignored');
    expect((await prs())[0]!.reviewDecision).toBe('review_required');
  });

  it('records a failed pipeline on the pull request whose head it ran on, not on another', async () => {
    const { key, secret, repo } = await gitlabSetup();
    const head = await seedPullRequest(db, repo.id, 1, { provider: 'gitlab', headSha: 'abc123' });
    const other = await seedPullRequest(db, repo.id, 2, { provider: 'gitlab', headSha: 'def456' });
    const result = await send('gitlab', key, gl(secret), {
      object_kind: 'pipeline',
      project: { id: 55 },
      object_attributes: { id: 1, sha: 'abc123', status: 'failed' },
      merge_request: { iid: 1 },
    });
    expect(result).toEqual({ outcome: 'applied' });
    expect((await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.id, head.id)))[0]!.checksStatus).toBe('failure');
    expect((await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.id, other.id)))[0]!.checksStatus).toBeNull();
    expect(eventLog()).toEqual(['merge_pull_request:updated']);

    expect(await send('gitlab', key, gl(secret), { object_kind: 'pipeline', project: { id: 55 }, object_attributes: { id: 2, sha: 'zzz', status: 'success' } })).toEqual({
      outcome: 'ignored',
      reason: 'unknown_pull_request',
    });
  });

  it('brings a GitLab issue in when issue sync is on, and ignores it when it is off', async () => {
    const off = await gitlabSetup();
    const hook = (action: string, state = 'opened') => ({
      object_kind: 'issue',
      user: { username: 'Octo-Dev' },
      project: { id: 55 },
      object_attributes: { id: 9004, iid: 4, title: 'Tabs break', description: 'steps', state, action, url: 'https://gitlab.com/acme/web/-/issues/4', updated_at: '2026-11-01 10:00:00 UTC' },
      labels: [{ title: 'bug' }],
      assignees: [],
    });
    expect(await send('gitlab', off.key, gl(off.secret), hook('open'))).toEqual({ outcome: 'ignored', reason: 'issue_sync_off' });
    expect(await db.select().from(schema.mergeExternalIssues)).toEqual([]);

    await db.update(schema.mergeRepositories).set({ issueSync: 'import' }).where(eq(schema.mergeRepositories.id, off.repo.id));
    expect(await send('gitlab', off.key, gl(off.secret), hook('open'))).toEqual({ outcome: 'applied' });
    const [link] = await db.select().from(schema.mergeExternalIssues);
    expect(link).toMatchObject({ provider: 'gitlab', number: 4, externalId: '9004', state: 'open', lastWriter: 'provider' });
    const created = await issueOf(link!.issueId);
    expect(created).toMatchObject({ title: 'Tabs break', description: 'steps', teamId: off.team.id });
    expect(eventLog()).toContain('merge_issue:created');

    // Closing it on GitLab closes it in WeldMerge.
    clearEvents();
    expect(await send('gitlab', off.key, gl(off.secret), { ...hook('close', 'closed'), object_attributes: { ...hook('close', 'closed').object_attributes, updated_at: '2026-11-01 11:00:00 UTC' } })).toEqual({ outcome: 'applied' });
    expect((await issueOf(link!.issueId)).status).toBe('done');
  });

  it('stores a note on a linked issue as a provider comment, and skips merge request and system notes', async () => {
    const { key, secret, repo, team } = await gitlabSetup({ issueSync: 'import' });
    const issue = await seedIssue(db, team.id, 2, { title: 'Linked' });
    await db.insert(schema.mergeExternalIssues).values({
      id: 'mxi_1', issueId: issue.id, repositoryId: repo.id, provider: 'gitlab', externalId: '9004', number: 4,
      url: 'https://gitlab.com/acme/web/-/issues/4', state: 'open', checksum: 'x', lastWriter: 'weldmerge',
    });
    const note = (type: string, system = false) => ({
      object_kind: 'note',
      user: { username: 'Octo-Dev', avatar_url: 'https://gl/o.png' },
      project: { id: 55 },
      issue: { iid: 4 },
      object_attributes: { id: 31, note: 'Looks like the cache', noteable_type: type, system, created_at: '2026-11-01 10:00:00 UTC', updated_at: '2026-11-01 10:00:00 UTC' },
    });
    expect(await send('gitlab', key, gl(secret), note('Issue'))).toEqual({ outcome: 'applied' });
    const [comment] = await db.select().from(schema.mergeComments);
    expect(comment).toMatchObject({ issueId: issue.id, body: 'Looks like the cache', externalId: '31', externalAuthorLogin: 'octo-dev', source: 'provider', authorUserId: null });
    expect(await send('gitlab', key, gl(secret), note('MergeRequest'))).toEqual({ outcome: 'ignored', reason: 'no_event' });
    expect(await send('gitlab', key, gl(secret), note('Issue', true))).toEqual({ outcome: 'ignored', reason: 'no_event' });
  });

  it('matches the author to a member who linked their GitLab account', async () => {
    const { key, secret } = await gitlabSetup();
    await db.insert(schema.mergeProviderAccounts).values({ id: 'mpa_bob', userId: 'user_bob', provider: 'gitlab', login: 'octo-dev', verifiedAt: new Date() });
    await send('gitlab', key, gl(secret), gitlabMrHook({ iid: 8, action: 'open', actor: 'Octo-Dev' }));
    expect((await prs())[0]!.authorUserId).toBe('user_bob');
  });
});

// ---------------------------------------------------------------------------
// Bitbucket Cloud
// ---------------------------------------------------------------------------

describe('Bitbucket Cloud', () => {
  const sign = (secret: string, body: string) => ({ 'x-hub-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, 'x-event-key': '' });

  async function deliver(key: string, secret: string, eventKey: string, payload: unknown, signWith = secret) {
    const body = JSON.stringify(payload);
    return send('bitbucket', key, { ...sign(signWith, body), 'x-event-key': eventKey }, body);
  }

  async function bitbucketSetup() {
    return setup('bitbucket', { externalId: '{repo-uuid-1}', fullName: 'acme/web', externalProject: 'acme' });
  }

  it('verifies the HMAC of the exact body', async () => {
    const { key, secret } = await bitbucketSetup();
    const payload = bitbucketPrHook({ id: 31 });
    expect(await deliver(key, secret, 'pullrequest:created', payload, 'wrong-secret')).toEqual({ outcome: 'ignored', reason: 'bad_signature' });
    expect(await prs()).toEqual([]);
    expect(await deliver(key, secret, 'pullrequest:created', payload)).toEqual({ outcome: 'applied' });
    expect((await prs())[0]).toMatchObject({ provider: 'bitbucket', number: 31, externalId: '31', state: 'open', authorLogin: 'octo-dev', headSha: 'sha31' });
  });

  it('applies updates and a merge through the same sync', async () => {
    const { key, secret } = await bitbucketSetup();
    await deliver(key, secret, 'pullrequest:created', bitbucketPrHook({ id: 31, updatedOn: '2026-11-01T10:00:00.000000+00:00' }));
    clearEvents();
    expect(await deliver(key, secret, 'pullrequest:updated', bitbucketPrHook({ id: 31, title: 'Renamed', updatedOn: '2026-11-01T11:00:00.000000+00:00' }))).toEqual({ outcome: 'applied' });
    expect((await prs())[0]!.title).toBe('Renamed');
    expect(await deliver(key, secret, 'pullrequest:fulfilled', bitbucketPrHook({ id: 31, state: 'MERGED', updatedOn: '2026-11-01T12:00:00.000000+00:00' }))).toEqual({ outcome: 'applied' });
    expect((await prs())[0]).toMatchObject({ state: 'merged' });
    expect(eventLog()).toEqual(['merge_pull_request:updated', 'merge_pull_request:updated', 'merge_pull_request:merged']);
    // An older delivery arriving late is ignored.
    expect(await deliver(key, secret, 'pullrequest:updated', bitbucketPrHook({ id: 31, title: 'Old', updatedOn: '2026-11-01T09:00:00.000000+00:00' }))).toEqual({ outcome: 'ignored', reason: 'stale' });
  });

  it('reads the pull request back after an approval and records the decision', async () => {
    const { key, secret } = await bitbucketSetup();
    const created = bitbucketPrHook({ id: 31, reviewers: ['TJanssen'], updatedOn: '2026-11-01T10:00:00.000000+00:00' });
    await deliver(key, secret, 'pullrequest:created', created);
    const calls = stubHttp({
      'GET api.bitbucket.org/2.0/repositories/acme/web/pullrequests/31': bitbucketPr({ id: 31, reviewers: ['TJanssen'], approvedBy: ['TJanssen'] }),
    });
    expect(await deliver(key, secret, 'pullrequest:approved', created)).toEqual({ outcome: 'applied' });
    expect((await prs())[0]!.reviewDecision).toBe('approved');
    expect(calls).toEqual([{ method: 'GET', url: 'api.bitbucket.org/2.0/repositories/acme/web/pullrequests/31', auth: 'bearer bitbucket-token' }]);
  });

  it('re-reads the build statuses after a commit status event', async () => {
    const { key, secret, repo } = await bitbucketSetup();
    await seedPullRequest(db, repo.id, 31, { provider: 'bitbucket', headSha: 'sha31' });
    const calls = stubHttp({
      'GET api.bitbucket.org/2.0/repositories/acme/web/commit/sha31/statuses': { values: [{ state: 'SUCCESSFUL' }, { state: 'FAILED' }] },
    });
    const payload = { repository: { uuid: '{repo-uuid-1}' }, commit_status: { state: 'FAILED', commit: { hash: 'sha31' } } };
    expect(await deliver(key, secret, 'repo:commit_status_updated', payload)).toEqual({ outcome: 'applied' });
    expect((await prs())[0]!.checksStatus).toBe('failure');
    expect(calls).toEqual([{ method: 'GET', url: 'api.bitbucket.org/2.0/repositories/acme/web/commit/sha31/statuses?pagelen=50', auth: 'bearer bitbucket-token' }]);
  });

  it('ignores a delivery about another repository and an event it does not read', async () => {
    const { key, secret } = await bitbucketSetup();
    expect(await deliver(key, secret, 'pullrequest:created', bitbucketPrHook({ id: 31 }, '{other-repo}'))).toEqual({ outcome: 'ignored', reason: 'no_event' });
    expect(await deliver(key, secret, 'repo:push', { repository: { uuid: '{repo-uuid-1}' } })).toEqual({ outcome: 'ignored', reason: 'no_event' });
  });
});

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

describe('Azure DevOps', () => {
  const basic = (password: string) => ({ authorization: `Basic ${btoa(`weldmerge:${password}`)}` });

  async function azureSetup() {
    return setup('azure_devops', { externalId: AZURE_REPO.id, fullName: 'Platform/web', externalProject: 'Platform' }, { host: 'https://dev.azure.com/acme', externalAccountId: 'acme' });
  }

  it('checks the service hook password', async () => {
    const { key, secret } = await azureSetup();
    const payload = azurePrHook({ id: 77 }, 'git.pullrequest.created');
    expect(await send('azure_devops', key, basic('wrong'), payload)).toEqual({ outcome: 'ignored', reason: 'bad_signature' });
    expect(await send('azure_devops', key, {}, payload)).toEqual({ outcome: 'ignored', reason: 'bad_signature' });
    expect(await prs()).toEqual([]);
  });

  it('mirrors a created pull request, records the decision from the votes and reads the checks back', async () => {
    const { key, secret } = await azureSetup();
    const calls = stubHttp({
      'GET dev.azure.com/acme/Platform/_apis/git/repositories/repo-guid-1/pullrequests/77': azurePr({ id: 77 }),
      'GET dev.azure.com/acme/Platform/_apis/git/repositories/repo-guid-1/pullRequests/77/statuses': { value: [{ state: 'succeeded' }] },
      'GET dev.azure.com/acme/Platform/_apis/policy/evaluations': { value: [{ status: 'running', configuration: { isBlocking: true } }] },
    });
    const payload = azurePrHook({ id: 77, title: 'Restrict tabs', reviewers: [['TJanssen@acme.com', 10], ['MPeters@acme.com', 0]] }, 'git.pullrequest.created');
    expect(await send('azure_devops', key, basic(secret), payload)).toEqual({ outcome: 'applied' });

    const [pr] = await prs();
    expect(pr).toMatchObject({
      provider: 'azure_devops',
      number: 77,
      state: 'open',
      authorLogin: 'octo-dev@acme.com',
      url: 'https://dev.azure.com/acme/Platform/_git/web/pullrequest/77',
      reviewDecision: 'approved',
      checksStatus: 'pending',
    });
    expect(pr!.requestedReviewers).toMatchObject([{ kind: 'user', login: 'mpeters@acme.com' }]);
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`).sort()).toEqual([
      'GET dev.azure.com/acme/Platform/_apis/git/repositories/repo-guid-1/pullRequests/77/statuses',
      'GET dev.azure.com/acme/Platform/_apis/git/repositories/repo-guid-1/pullrequests/77',
      'GET dev.azure.com/acme/Platform/_apis/policy/evaluations',
    ]);
    expect(calls.every((c) => c.auth === 'bearer azure_devops-token')).toBe(true);
  });

  it('turns a rejecting vote into changes_requested and a merge into merged', async () => {
    const { key, secret } = await azureSetup();
    stubHttp({});
    await send('azure_devops', key, basic(secret), azurePrHook({ id: 77, reviewers: [['TJanssen@acme.com', -10]] }, 'git.pullrequest.updated', '2026-11-01T10:00:00.000Z'));
    expect((await prs())[0]!.reviewDecision).toBe('changes_requested');
    expect(
      await send(
        'azure_devops',
        key,
        basic(secret),
        azurePrHook({ id: 77, status: 'completed', closedDate: '2026-11-01T11:00:00Z', reviewers: [['TJanssen@acme.com', 10]] }, 'git.pullrequest.merged', '2026-11-01T11:00:00.000Z'),
      ),
    ).toEqual({ outcome: 'applied' });
    expect((await prs())[0]).toMatchObject({ state: 'merged', reviewDecision: 'approved' });
  });

  it('keeps the mirror when Azure DevOps cannot be read for the checks', async () => {
    const { key, secret } = await azureSetup();
    stubHttp({ 'GET dev.azure.com/acme/Platform/_apis/git/repositories/repo-guid-1/pullrequests/77': failure(503) });
    const result = await send('azure_devops', key, basic(secret), azurePrHook({ id: 77 }, 'git.pullrequest.created'));
    expect(result).toEqual({ outcome: 'applied' });
    expect((await prs())[0]).toMatchObject({ number: 77, checksStatus: null });
  });

  it('ignores an event type it does not read', async () => {
    const { key, secret } = await azureSetup();
    expect(await send('azure_devops', key, basic(secret), { ...azurePrHook({ id: 77 }), eventType: 'build.complete' })).toEqual({ outcome: 'ignored', reason: 'no_event' });
  });
});
