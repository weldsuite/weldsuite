/**
 * DB-backed tests for /api/merge/connections and /api/merge/repositories on a
 * real tenant schema (pglite), with GitHub's REST API stubbed by URL and method
 * (installation tokens are minted for real against the stub's token exchange).
 * Run on both backends by the `merge` conformance suite. What must not regress:
 *   1. Connecting GitHub answers with the workspace's newest active connection (the
 *      install flow writes it), and `needs_install` when there is none. Removing a
 *      connection never calls GitHub.
 *   2. Adding a repository loads open pull requests and those closed or merged
 *      in the last 30 days, links them to issues by key, and moves NO issue.
 *   3. issue_sync accepts off, import and two_way on GitHub and GitLab, only off elsewhere (422).
 *   4. Changing connections and repositories needs merge_connections:manage.
 *   5. GitHub failing is a 502, a worker without the App's credentials a 503.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  ConnectMergeGithubResult,
  MergeAvailableRepository,
  MergeConnectionDto,
  MergeRepositoryDto,
  MergeRepositorySyncResult,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import connectionsRoutes from '../connections';
import repositoriesRoutes from './index';
import {
  ADMIN,
  MEMBER,
  VIEWER,
  clearEvents,
  errorCode,
  eventTypes,
  events,
  githubPull,
  jsonInit,
  makeApp,
  newId,
  ok,
  openDb,
  perRun,
  resetTables,
  stubGithub,
} from '../../test/helpers';
import {
  seedConnection,
  seedIssue,
  seedPullRequest,
  seedRepository,
  seedTeam,
} from '../../test/seed';

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

const connections = (grants = ADMIN, env = {}) => makeApp(db, '/api/merge/connections', connectionsRoutes, { grants, env });
const repositories = (grants = ADMIN, env = {}) => makeApp(db, '/api/merge/repositories', repositoriesRoutes, { grants, env });

const REPO_900 = { id: 900, full_name: 'acme/web', private: true, default_branch: 'main', html_url: 'https://github.com/acme/web' };

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

describe('connect GitHub', () => {
  it('says needs_install while the workspace has no active GitHub connection, with the install page when the App is known', async () => {
    const res = await connections().request('/api/merge/connections/github', jsonInit({}));
    expect(await ok<ConnectMergeGithubResult>(res)).toEqual({ status: 'needs_install' });
    await seedConnection(db, { status: 'suspended' });
    await seedConnection(db, { externalAccountId: '77', status: 'revoked' });
    await seedConnection(db, { externalAccountId: '78', deletedAt: new Date() });
    expect(await ok<ConnectMergeGithubResult>(await connections().request('/api/merge/connections/github', jsonInit({})))).toEqual({
      status: 'needs_install',
    });
    const withSlug = await connections(ADMIN, { GITHUB_APP_SLUG: 'weldsuite' }).request('/api/merge/connections/github', jsonInit({}));
    expect(await ok<ConnectMergeGithubResult>(withSlug)).toEqual({
      status: 'needs_install',
      url: 'https://github.com/apps/weldsuite/installations/new',
    });
    expect(events).toEqual([]);
  });

  it('answers connected with the newest active connection, writing and publishing nothing', async () => {
    const older = await seedConnection(db, { externalAccountId: '1', createdAt: new Date('2026-10-01T00:00:00Z') });
    const newer = await seedConnection(db, { externalAccountId: '2', accountLogin: 'acme-two', createdAt: new Date('2026-11-01T00:00:00Z') });
    const result = await ok<ConnectMergeGithubResult>(await connections().request('/api/merge/connections/github', jsonInit({})));
    expect(result.status).toBe('connected');
    if (result.status !== 'connected') throw new Error('unreachable');
    expect(result.connection).toMatchObject({
      id: newer.id,
      provider: 'github',
      externalAccountId: '2',
      accountLogin: 'acme-two',
      accountType: 'organization',
      host: null,
      status: 'active',
      repositoryCount: 0,
    });
    expect(result.connection.id).not.toBe(older.id);
    expect(result.connection).not.toHaveProperty('credentials');
    expect(events).toEqual([]);
    expect(await db.select().from(schema.mergeConnections)).toHaveLength(2);
  });

  it('needs merge_connections:manage', async () => {
    await seedConnection(db);
    expect((await connections(MEMBER).request('/api/merge/connections/github', jsonInit({}))).status).toBe(403);
    expect((await connections(VIEWER).request('/api/merge/connections/github', jsonInit({}))).status).toBe(403);
  });
});

describe('connections list, delete and available repositories', () => {
  it('lists connections with their repository counts to a reader', async () => {
    const connection = await seedConnection(db);
    await seedRepository(db, connection.id, { externalId: '1', fullName: 'acme/a' });
    await seedRepository(db, connection.id, { externalId: '2', fullName: 'acme/b' });
    await seedRepository(db, connection.id, { externalId: '3', fullName: 'acme/c', deletedAt: new Date() });
    const body = (await (await connections(VIEWER).request('/api/merge/connections')).json()) as {
      data: MergeConnectionDto[];
      pagination: unknown;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: connection.id, repositoryCount: 2, status: 'active' });
    expect(body.pagination).toEqual({ totalCount: 1, hasMore: false, cursor: null });
    expect((await connections([]).request('/api/merge/connections')).status).toBe(403);
  });

  it('removes a connection and its repositories without calling GitHub, and publishes their events', async () => {
    const calls = stubGithub({});
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    clearEvents();

    expect((await connections(MEMBER).request(`/api/merge/connections/${connection.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await connections().request('/api/merge/connections/mcn_unknown', { method: 'DELETE' })).status).toBe(404);
    expect((await connections().request(`/api/merge/connections/${connection.id}`, { method: 'DELETE' })).status).toBe(204);

    expect(eventTypes()).toEqual(['merge_repository:deleted', 'merge_connection:deleted']);
    expect(events[0]!.entityId).toBe(repo.id);
    expect(calls).toEqual([]);
    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, connection.id));
    expect(row!.deletedAt).not.toBeNull();
    expect(await ok<MergeConnectionDto[]>(await connections().request('/api/merge/connections'))).toEqual([]);
    expect(await ok<MergeRepositoryDto[]>(await repositories().request('/api/merge/repositories'))).toEqual([]);
    // The removed connection is gone: connecting says the App has to be installed again.
    expect(await ok<ConnectMergeGithubResult>(await connections().request('/api/merge/connections/github', jsonInit({})))).toEqual({
      status: 'needs_install',
    });
  });

  it('lists what the installation can see, marking the repositories already tracked', async () => {
    const connection = await seedConnection(db, { externalAccountId: '4242' });
    await seedRepository(db, connection.id, { externalId: '900' });
    const calls = stubGithub({
      'GET /installation/repositories': { total_count: 2, repositories: [REPO_900, { id: 901, full_name: 'acme/api', private: false, default_branch: null }] },
    });
    const rows = await ok<MergeAvailableRepository[]>(
      await connections().request(`/api/merge/connections/${connection.id}/available-repositories`),
    );
    expect(rows).toEqual([
      { externalId: '900', fullName: 'acme/web', private: true, defaultBranch: 'main', url: 'https://github.com/acme/web', externalProject: null, added: true },
      { externalId: '901', fullName: 'acme/api', private: false, defaultBranch: null, url: null, externalProject: null, added: false },
    ]);
    expect(calls).toEqual(perRun([{ method: 'GET', url: '/installation/repositories?per_page=100&page=1' }]));
  });

  it('answers 404 for an unknown connection, 502 when GitHub fails, 503 without the App credentials, 403 for a reader', async () => {
    const connection = await seedConnection(db);
    const path = `/api/merge/connections/${connection.id}/available-repositories`;
    stubGithub({});
    expect((await connections().request('/api/merge/connections/mcn_unknown/available-repositories')).status).toBe(404);
    expect((await connections(VIEWER).request(path)).status).toBe(403);

    stubGithub({ 'GET /installation/repositories': new Response('boom', { status: 500 }) });
    const failed = await connections().request(path);
    expect(failed.status).toBe(502);
    expect(await errorCode(failed)).toBe('UPSTREAM_ERROR');

    const unconfigured = await connections(ADMIN, { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }).request(path);
    expect(unconfigured.status).toBe(503);
    expect(await errorCode(unconfigured)).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('add a repository (backfill)', () => {
  /** GitHub with two open pull requests and two closed ones (one recent merge, one older than 30 days). */
  function githubWithPulls(extra: Record<string, unknown> = {}) {
    const open = [
      githubPull({ id: 5001, number: 1, title: 'Fix tabs', headRef: 'plat-1-fix-tabs', updatedAt: daysAgo(1), login: 'Octo-Dev', reviewers: ['Reviewer-One'] }),
      githubPull({ id: 5002, number: 2, title: 'Draft idea', draft: true, updatedAt: daysAgo(40) }),
    ];
    const closed = [
      githubPull({ id: 5003, number: 3, title: 'Ship PLAT-2', merged: true, state: 'closed', updatedAt: daysAgo(3), mergedAt: daysAgo(3) }),
      githubPull({ id: 5004, number: 4, title: 'Ancient', state: 'closed', merged: true, updatedAt: daysAgo(45), mergedAt: daysAgo(45) }),
    ];
    return stubGithub({
      'GET /repositories/900': REPO_900,
      'GET /repos/acme/web/pulls': (url: URL) => (url.searchParams.get('state') === 'open' ? open : closed),
      ...extra,
    });
  }

  async function connectionAndIssues() {
    const team = await seedTeam(db, 'PLAT');
    const one = await seedIssue(db, team.id, 1, { status: 'todo' });
    const two = await seedIssue(db, team.id, 2, { status: 'in_progress' });
    const connection = await seedConnection(db);
    clearEvents();
    return { team, one, two, connection };
  }

  const add = (connectionId: string, extra: Record<string, unknown> = {}, grants = ADMIN) =>
    repositories(grants).request('/api/merge/repositories', jsonInit({ connectionId, externalId: '900', ...extra }));

  it('looks the repository up, loads open and recently closed pull requests, links them, and moves no issue', async () => {
    const calls = githubWithPulls();
    const { team, one, two, connection } = await connectionAndIssues();
    const result = await ok<MergeRepositorySyncResult>(await add(connection.id, { teamId: team.id }), 201);

    expect(result.pullRequestsSynced).toBe(3);
    expect(result.linksCreated).toBe(2);
    expect(result.repository).toMatchObject({
      connectionId: connection.id,
      provider: 'github',
      externalId: '900',
      fullName: 'acme/web',
      defaultBranch: 'main',
      private: true,
      url: 'https://github.com/acme/web',
      teamId: team.id,
      issueSync: 'off',
      prSync: true,
      openPullRequestCount: 2,
    });
    expect(result.repository.lastSyncedAt).not.toBeNull();

    // Open ones, then closed ones until the first older than 30 days.
    expect(calls.map((c) => c.url)).toEqual(
      perRun([
        '/repositories/900',
        '/repos/acme/web/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1',
        '/repos/acme/web/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1',
      ]),
    );
    const mirrored = await db.select().from(schema.mergePullRequests);
    expect(mirrored.map((p) => p.number).sort()).toEqual([1, 2, 3]);
    const merged = mirrored.find((p) => p.number === 3)!;
    expect(merged).toMatchObject({ state: 'merged', title: 'Ship PLAT-2' });
    expect(mirrored.find((p) => p.number === 1)).toMatchObject({
      authorLogin: 'octo-dev',
      headRef: 'plat-1-fix-tabs',
      additions: 10,
      requestedReviewers: [{ kind: 'user', login: 'reviewer-one', avatarUrl: null, userId: null }],
    });

    // Links by key; the merged one closes PLAT-2, yet nothing moves on a backfill.
    const links = await db.select().from(schema.mergeIssuePullRequests);
    expect(links.map((l) => [l.issueId, l.source, l.closes]).sort()).toEqual(
      [
        [one.id, 'auto', true],
        [two.id, 'auto', true],
      ].sort(),
    );
    const issues = await db.select().from(schema.mergeIssues);
    expect(issues.find((i) => i.id === one.id)!.status).toBe('todo');
    expect(issues.find((i) => i.id === two.id)!.status).toBe('in_progress');
    expect(issues.some((i) => i.completedAt !== null)).toBe(false);

    // One repository event and one created event per pull request; no merged/closed news, no issue events.
    expect(eventTypes().sort()).toEqual(
      ['merge_pull_request:created', 'merge_pull_request:created', 'merge_pull_request:created', 'merge_repository:created'].sort(),
    );
  });

  it('matches pull request authors and reviewers to members by their saved GitHub login', async () => {
    githubWithPulls();
    const { connection } = await connectionAndIssues();
    await db.insert(schema.mergeProviderAccounts).values([
      { id: 'mpa_a', userId: 'user_alice', provider: 'github', login: 'octo-dev' },
      { id: 'mpa_b', userId: 'user_bob', provider: 'github', login: 'reviewer-one' },
    ]);
    await ok(await add(connection.id), 201);
    const [pr] = await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.number, 1));
    expect(pr).toMatchObject({ authorUserId: 'user_alice' });
    expect(pr!.requestedReviewers).toEqual([{ kind: 'user', login: 'reviewer-one', avatarUrl: null, userId: 'user_bob' }]);
  });

  it('refuses an already tracked repository (409), an unknown connection or repository or team (404), bad input (400)', async () => {
    githubWithPulls();
    const { connection } = await connectionAndIssues();
    await ok(await add(connection.id), 201);
    clearEvents();

    const dupe = await add(connection.id);
    expect(dupe.status).toBe(409);
    expect(await errorCode(dupe)).toBe('CONFLICT');
    expect((await add('mcn_unknown')).status).toBe(404);
    expect((await add(connection.id, { externalId: '777' })).status).toBe(404);
    expect((await add(connection.id, { externalId: '900', teamId: 'mtm_unknown' })).status).toBe(404);
    expect((await repositories().request('/api/merge/repositories', jsonInit({ externalId: '900' }))).status).toBe(400);
    expect((await repositories().request('/api/merge/repositories', jsonInit({ connectionId: connection.id }))).status).toBe(400);
    expect(events).toEqual([]);
    expect(await db.select().from(schema.mergeRepositories)).toHaveLength(1);
  });

  it('does not add a repository of a revoked connection', async () => {
    githubWithPulls();
    const connection = await seedConnection(db, { status: 'revoked' });
    expect((await add(connection.id)).status).toBe(404);
  });

  it('needs merge_connections:manage, and a GitHub failure is a 502 that tracks nothing new', async () => {
    const { connection } = await connectionAndIssues();
    githubWithPulls();
    expect((await add(connection.id, {}, MEMBER)).status).toBe(403);
    expect((await add(connection.id, {}, VIEWER)).status).toBe(403);

    stubGithub({ 'GET /repositories/900': new Response('down', { status: 503 }) });
    const failed = await add(connection.id);
    expect(failed.status).toBe(502);
    expect(await db.select().from(schema.mergeRepositories)).toEqual([]);
  });

  it('adds with pr_sync off when asked', async () => {
    githubWithPulls();
    const { connection } = await connectionAndIssues();
    const result = await ok<MergeRepositorySyncResult>(await add(connection.id, { prSync: false }), 201);
    expect(result.repository.prSync).toBe(false);
  });
});

describe('repositories: list, update, delete, refresh', () => {
  it('lists repositories with their open pull request counts', async () => {
    const connection = await seedConnection(db);
    const web = await seedRepository(db, connection.id, { externalId: '900', fullName: 'acme/web' });
    const api = await seedRepository(db, connection.id, { externalId: '901', fullName: 'acme/api' });
    await seedRepository(db, connection.id, { externalId: '902', fullName: 'acme/gone', deletedAt: new Date() });
    await seedPullRequest(db, web.id, 1);
    await seedPullRequest(db, web.id, 2);
    await seedPullRequest(db, web.id, 3, { state: 'merged' });
    const rows = await ok<MergeRepositoryDto[]>(await repositories(VIEWER).request('/api/merge/repositories'));
    expect(rows.map((r) => [r.fullName, r.openPullRequestCount])).toEqual([
      ['acme/api', 0],
      ['acme/web', 2],
    ]);
    expect(rows[0]!.id).toBe(api.id);
    expect((await repositories([]).request('/api/merge/repositories')).status).toBe(403);
  });

  it('updates team and pr_sync, accepts issueSync modes on GitHub, and refuses them with 422 on providers without issue sync', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const team = await seedTeam(db, 'PLAT');
    clearEvents();
    const patch = (body: unknown, id = repo.id, grants = ADMIN) =>
      repositories(grants).request(`/api/merge/repositories/${id}`, jsonInit(body, 'PATCH'));

    const updated = await ok<MergeRepositoryDto>(await patch({ teamId: team.id, prSync: false, issueSync: 'off' }));
    expect(updated).toMatchObject({ teamId: team.id, prSync: false, issueSync: 'off' });
    expect(eventTypes()).toEqual(['merge_repository:updated']);
    expect(events[0]!.changes).toMatchObject({ teamId: { old: null, new: team.id }, prSync: { old: true, new: false } });
    expect((await ok<MergeRepositoryDto>(await patch({ teamId: null }))).teamId).toBeNull();

    clearEvents();
    for (const issueSync of ['two_way', 'import', 'off']) {
      const res = await patch({ issueSync });
      expect((await ok<MergeRepositoryDto>(res)).issueSync, issueSync).toBe(issueSync);
    }
    clearEvents();
    const bitbucket = await seedConnection(db, { provider: 'bitbucket', externalAccountId: 'bb-1' });
    const bbRepo = await seedRepository(db, bitbucket.id, { provider: 'bitbucket', externalId: 'bb-900', fullName: 'acme/bb' });
    for (const issueSync of ['two_way', 'import']) {
      const res = await patch({ issueSync }, bbRepo.id);
      expect(res.status, issueSync).toBe(422);
      expect(await errorCode(res)).toBe('UNPROCESSABLE_ENTITY');
    }
    expect((await patch({ issueSync: 'both' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ teamId: 'mtm_unknown' })).status).toBe(404);
    expect((await patch({ prSync: true }, 'mrp_unknown')).status).toBe(404);
    expect((await patch({ prSync: true }, repo.id, MEMBER)).status).toBe(403);
    expect(events).toEqual([]);
  });

  it('removes a repository (soft) and publishes merge_repository:deleted', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    expect((await repositories(MEMBER).request(`/api/merge/repositories/${repo.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await repositories().request('/api/merge/repositories/mrp_unknown', { method: 'DELETE' })).status).toBe(404);
    expect((await repositories().request(`/api/merge/repositories/${repo.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_repository:deleted']);
    expect(events[0]!.data).toEqual({ id: repo.id, connectionId: connection.id, provider: 'github', fullName: 'acme/web', teamId: null });
    const [row] = await db.select().from(schema.mergeRepositories).where(eq(schema.mergeRepositories.id, repo.id));
    expect(row!.deletedAt).not.toBeNull();
    expect((await repositories().request(`/api/merge/repositories/${repo.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refreshes: updates changed pull requests, adds new ones and links created since, and moves no issue', async () => {
    const team = await seedTeam(db, 'PLAT');
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    const unchanged = await seedPullRequest(db, repo.id, 1, { title: 'Same', externalId: '5001', providerUpdatedAt: new Date('2026-10-30T10:00:00Z') });
    const stale = await seedPullRequest(db, repo.id, 2, { title: 'Old title', externalId: '5002', headRef: 'feature/2', providerUpdatedAt: new Date('2026-10-30T10:00:00Z'), additions: 40, deletions: 5, changedFiles: 9 });
    const later = await seedIssue(db, team.id, 7, { status: 'todo' });
    const closedAgo = daysAgo(2);

    stubGithub({
      'GET /repos/acme/web/pulls': (url: URL) =>
        url.searchParams.get('state') === 'open'
          ? [
              // The list leaves out additions/deletions/changed_files, so the stored numbers must survive.
              { ...githubPull({ id: 5001, number: 1, title: 'Same', updatedAt: '2026-10-30T10:00:00Z' }) },
              {
                ...githubPull({ id: 5002, number: 2, title: 'Renamed for PLAT-7', updatedAt: '2026-11-02T10:00:00Z', headRef: 'feature/2' }),
                additions: undefined,
                deletions: undefined,
                changed_files: undefined,
              },
              githubPull({ id: 5009, number: 9, title: 'Brand new', updatedAt: daysAgo(1) }),
            ]
          : [githubPull({ id: 5010, number: 10, title: 'Merged lately', merged: true, state: 'closed', updatedAt: closedAgo, mergedAt: closedAgo })],
    });
    const result = await ok<MergeRepositorySyncResult>(await repositories().request(`/api/merge/repositories/${repo.id}/sync`, jsonInit({})));
    expect(result.pullRequestsSynced).toBe(4);
    expect(result.linksCreated).toBe(1);
    expect(result.repository.lastSyncedAt).not.toBeNull();
    expect(result.repository.openPullRequestCount).toBe(3);

    const rows = await db.select().from(schema.mergePullRequests);
    expect(rows.find((r) => r.id === unchanged.id)!.title).toBe('Same');
    expect(rows.find((r) => r.id === stale.id)).toMatchObject({ title: 'Renamed for PLAT-7', additions: 40, deletions: 5, changedFiles: 9 });
    expect(rows).toHaveLength(4);
    expect((await db.select().from(schema.mergeIssuePullRequests).where(eq(schema.mergeIssuePullRequests.issueId, later.id)))).toHaveLength(1);
    expect((await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, later.id)))[0]!.status).toBe('todo');
    // Unchanged is not rewritten, so only 3 events: one updated, two created.
    expect(eventTypes().sort()).toEqual(['merge_pull_request:created', 'merge_pull_request:created', 'merge_pull_request:updated']);
  });

  it('refresh answers 404 for an unknown repository, 403 without manage, 502 when GitHub fails', async () => {
    const connection = await seedConnection(db);
    const repo = await seedRepository(db, connection.id);
    stubGithub({});
    expect((await repositories().request('/api/merge/repositories/mrp_unknown/sync', jsonInit({}))).status).toBe(404);
    expect((await repositories(MEMBER).request(`/api/merge/repositories/${repo.id}/sync`, jsonInit({}))).status).toBe(403);
    stubGithub({ 'GET /repos/acme/web/pulls': new Response('rate limited', { status: 403 }) });
    expect((await repositories().request(`/api/merge/repositories/${repo.id}/sync`, jsonInit({}))).status).toBe(502);
  });
});
