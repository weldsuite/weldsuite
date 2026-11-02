/**
 * `/api/workflow-github` on pglite, through the test app (so the conformance
 * harness runs it against both backends): the install link and its signed
 * state, the workspace's connection (read, revoke, recover from a known
 * installation, the installations the App can see), the repositories the
 * installation reaches and the ones linked to WeldFlow, and GitHub Projects
 * (available ones, a Project's Status field).
 *
 * GitHub answers from a stub by URL. connect-api caches installation tokens
 * per installation in the isolate, so every test that mints one uses an
 * installation of its own.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { workflowGithubRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { verifyInstallStateJwt } from '../../services/github/auth';
import type { Env, Variables } from '../../types';

const { privateKey: GITHUB_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const BASE = '/api/workflow-github';
const ORG = 'org_test_default';
const STATE_SECRET = 'sk_test_github_state';

const ENV = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_SLUG: 'weldsuite-test',
  GITHUB_APP_PRIVATE_KEY,
  CLERK_SECRET_KEY: STATE_SECRET,
  DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32),
};

/** The fetch the stub hands loopback calls to: the conformance harness's own. */
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GitHub by URL: token exchanges succeed; `impl` answers the rest. */
function stubGithub(impl: (url: string, init?: RequestInit) => Response | Promise<Response> = () => json({})) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isLoopback(url)) return realFetch(input, init);
    if (url.endsWith('/access_tokens')) {
      return json({ token: 'ghs_test_token', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app(env: Record<string, unknown> = ENV, granted = permissions('integrations:github:manage')) {
  return createTestApp<Env, Variables>(BASE, workflowGithubRoutes, {
    context: { permissions: granted, tenantDb: db },
    env: env as never,
  }).request;
}

let seq = 0;

async function seedConnection(over: Partial<typeof schema.githubConnections.$inferInsert> = {}) {
  const id = `ghc_wg_${++seq}`;
  await db.insert(schema.githubConnections).values({
    id,
    workspaceId: ORG,
    installationId: 900_000 + seq,
    appSlug: 'weldsuite-test',
    ownerType: 'org',
    ownerLogin: 'acme-corp',
    status: 'active',
    ...over,
  });
  return id;
}

async function clearConnections() {
  await db.delete(schema.githubRepoLinks);
  await db.delete(schema.githubProjectLinks);
  await db.delete(schema.githubConnections);
}

describe('GET /install-url', () => {
  it('links to the App install page with a state signed for this workspace', async () => {
    const res = await app()(`${BASE}/install-url?returnTo=${encodeURIComponent('https://app.example/back')}&projectId=prj_1`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { url: string } };
    expect(data.url.startsWith('https://github.com/apps/weldsuite-test/installations/new?state=')).toBe(true);
    const state = decodeURIComponent(data.url.split('state=')[1]);
    const claims = await verifyInstallStateJwt(state, STATE_SECRET);
    expect(claims?.workspaceId).toBe(ORG);
    expect(claims?.userId).toBe('user_test_default');
    expect(claims?.projectId).toBe('prj_1');
    expect(claims?.returnTo).toBe('https://app.example/back');
    expect(claims?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyInstallStateJwt(state, 'another-secret')).toBeNull();
  });

  it('answers 500 without the App slug', async () => {
    const res = await app({ ...ENV, GITHUB_APP_SLUG: undefined })(`${BASE}/install-url`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('GitHub App is not configured');
  });

  it('refuses a caller without integrations:github:manage', async () => {
    const res = await app(ENV, permissions('integrations:read'))(`${BASE}/install-url`);
    expect(res.status).toBe(403);
  });
});

describe('the connection', () => {
  it('answers null without one, the row without its secret with one, and revokes it', async () => {
    await clearConnections();
    let res = await app()(`${BASE}/connection`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toBeNull();

    const id = await seedConnection({ webhookSecret: 'sealed-secret', scopes: ['contents'] });
    res = await app()(`${BASE}/connection`);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.id).toBe(id);
    expect(data.ownerLogin).toBe('acme-corp');
    expect(data.scopes).toEqual(['contents']);
    expect(data).not.toHaveProperty('webhookSecret');

    res = await app()(`${BASE}/connection`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.id, id));
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
  });
});

describe('GET /installations/discoverable', () => {
  it('lists the installations the App can see', async () => {
    stubGithub((url) =>
      url === 'https://api.github.com/app/installations?per_page=100'
        ? json([
            { id: 11, app_slug: 'weldsuite-test', account: { login: 'acme-corp', type: 'Organization' }, repository_selection: 'all' },
            { id: 12, app_slug: 'weldsuite-test', account: { login: 'jane', type: 'User' }, repository_selection: 'selected' },
          ])
        : json({ message: 'Not Found' }, 404),
    );
    const res = await app()(`${BASE}/installations/discoverable`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; pagination: { totalCount: number } };
    expect(body.data).toEqual([
      { id: 11, accountLogin: 'acme-corp', accountType: 'Organization', appSlug: 'weldsuite-test', repositorySelection: 'all' },
      { id: 12, accountLogin: 'jane', accountType: 'User', appSlug: 'weldsuite-test', repositorySelection: 'selected' },
    ]);
    expect(body.pagination.totalCount).toBe(2);
  });

  it('answers 500 when GitHub refuses', async () => {
    stubGithub(() => json({ message: 'Bad credentials' }, 401));
    const res = await app()(`${BASE}/installations/discoverable`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Failed to fetch GitHub installations');
  });

  it('answers 500 without the App credentials', async () => {
    const res = await app({ ...ENV, GITHUB_APP_ID: undefined })(`${BASE}/installations/discoverable`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('GitHub App is not configured');
  });
});

describe('POST /recover', () => {
  const installation = (id: number, login = 'acme-corp', type = 'Organization') =>
    json({ id, app_slug: 'weldsuite-test', account: { login, type }, repository_selection: 'all' });

  it('creates the connection from an installation GitHub knows', async () => {
    await clearConnections();
    stubGithub((url) => (url === 'https://api.github.com/app/installations/4242' ? installation(4242) : json({}, 404)));
    const res = await app()(`${BASE}/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 4242 }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ installationId: 4242, ownerType: 'org', ownerLogin: 'acme-corp', status: 'active', workspaceId: ORG });
    expect(data).not.toHaveProperty('webhookSecret');
    const [row] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.installationId, 4242));
    expect(row.webhookSecret).toBeTruthy();
    expect(row.createdBy).toBe('user_test_default');
  });

  it('re-points an existing installation at this workspace', async () => {
    await clearConnections();
    const id = await seedConnection({ installationId: 4343, workspaceId: 'org_elsewhere', status: 'revoked' });
    stubGithub((url) => (url === 'https://api.github.com/app/installations/4343' ? installation(4343, 'jane', 'User') : json({}, 404)));
    const res = await app()(`${BASE}/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 4343 }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id, workspaceId: ORG, ownerType: 'user', ownerLogin: 'jane', status: 'active', revokedAt: null });
  });

  it('refuses an installation id that is not a positive integer', async () => {
    for (const installationId of [0, -3, 1.5, '12']) {
      const res = await app()(`${BASE}/recover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installationId }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('answers 500 when GitHub does not know the installation', async () => {
    stubGithub(() => json({ message: 'Not Found' }, 404));
    const res = await app()(`${BASE}/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 4444 }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Failed to recover GitHub installation');
  });

  it('answers 500 without an encryption key', async () => {
    const res = await app({ ...ENV, DATABASE_ENCRYPTION_KEY: undefined })(`${BASE}/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 4545 }),
    });
    expect(res.status).toBe(500);
  });
});

describe('repositories', () => {
  it('lists the repositories the installation reaches', async () => {
    await clearConnections();
    await seedConnection({ installationId: 5101 });
    stubGithub((url) =>
      url === 'https://api.github.com/installation/repositories?per_page=100&page=1'
        ? json({
            total_count: 2,
            repositories: [
              { id: 1, full_name: 'acme-corp/api', default_branch: 'main', private: true },
              { id: 2, full_name: 'acme-corp/web', default_branch: 'develop', private: false },
            ],
          })
        : json({}, 404),
    );
    const res = await app()(`${BASE}/repos/available`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: { totalCount: number; hasMore: boolean } };
    expect(body.data).toEqual([
      { id: 1, fullName: 'acme-corp/api', defaultBranch: 'main', private: true },
      { id: 2, fullName: 'acme-corp/web', defaultBranch: 'develop', private: false },
    ]);
    expect(body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
  });

  it('answers 404 without an active connection', async () => {
    await clearConnections();
    await seedConnection({ status: 'suspended' });
    const res = await app()(`${BASE}/repos/available`);
    expect(res.status).toBe(404);
  });

  it('links, lists, updates and unlinks a repository', async () => {
    await clearConnections();
    const connectionId = await seedConnection();

    let res = await app()(`${BASE}/repos/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 77, repoFullName: 'acme-corp/api', projectId: 'prj_repo', extra: 'ignored' }),
    });
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(created).toMatchObject({
      connectionId,
      workspaceId: ORG,
      projectId: 'prj_repo',
      repoId: 77,
      repoFullName: 'acme-corp/api',
      defaultBranch: null,
      syncIssues: true,
      syncDirection: 'bidirectional',
      lastSyncedAt: null,
    });
    const linkId = created.id as string;

    await app()(`${BASE}/repos/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 78, repoFullName: 'acme-corp/web', syncDirection: 'inbound', syncIssues: false }),
    });

    res = await app()(`${BASE}/repos/linked`);
    let list = (await res.json()) as { data: Array<{ repoFullName: string }>; pagination: Record<string, unknown> };
    expect(list.data.map((r) => r.repoFullName).sort()).toEqual(['acme-corp/api', 'acme-corp/web']);
    expect(list.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });

    res = await app()(`${BASE}/repos/linked?projectId=prj_repo`);
    list = (await res.json()) as typeof list;
    expect(list.data.map((r) => r.repoFullName)).toEqual(['acme-corp/api']);

    res = await app()(`${BASE}/repos/linked?limit=1`);
    list = (await res.json()) as typeof list;
    expect(list.data).toHaveLength(1);
    expect(list.pagination.hasMore).toBe(true);
    expect(list.pagination.totalCount).toBe(2);

    res = await app()(`${BASE}/repos/linked?limit=500`);
    expect(res.status).toBe(400);

    res = await app()(`${BASE}/repos/${linkId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: null, defaultBranch: 'main', syncDirection: 'outbound', syncIssues: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      projectId: null,
      defaultBranch: 'main',
      syncDirection: 'outbound',
      syncIssues: false,
    });

    res = await app()(`${BASE}/repos/${linkId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ syncDirection: 'sideways' }),
    });
    expect(res.status).toBe(400);

    res = await app()(`${BASE}/repos/${linkId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    res = await app()(`${BASE}/repos/${linkId}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    res = await app()(`${BASE}/repos/${linkId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultBranch: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('refuses a link without an active connection or with a bad body', async () => {
    await clearConnections();
    let res = await app()(`${BASE}/repos/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 1, repoFullName: 'acme-corp/api' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'No active GitHub connection. Install the GitHub App first.',
    );

    await seedConnection();
    res = await app()(`${BASE}/repos/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 0, repoFullName: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 500 when the repository is already linked', async () => {
    await clearConnections();
    await seedConnection();
    const body = JSON.stringify({ repoId: 91, repoFullName: 'acme-corp/twice' });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    expect((await app()(`${BASE}/repos/link`, init)).status).toBe(201);
    const res = await app()(`${BASE}/repos/link`, init);
    expect(res.status).toBe(500);
  });

  it('checks the connection and the link before a full sync, which has no binding', async () => {
    await clearConnections();
    let res = await app()(`${BASE}/repos/ghrl_missing/sync`, { method: 'POST' });
    expect(res.status).toBe(400);

    await seedConnection();
    res = await app()(`${BASE}/repos/ghrl_missing/sync`, { method: 'POST' });
    expect(res.status).toBe(404);

    const created = await app()(`${BASE}/repos/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 92, repoFullName: 'acme-corp/sync' }),
    });
    const linkId = ((await created.json()) as { data: { id: string } }).data.id;
    res = await app()(`${BASE}/repos/${linkId}/sync`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'GitHub full-sync workflow binding not configured',
    );
  });
});

describe('GitHub Projects', () => {
  it('lists the owner’s Projects, page by page', async () => {
    await clearConnections();
    await seedConnection({ installationId: 6101, ownerLogin: 'acme-corp', ownerType: 'org' });
    stubGithub((url, init) => {
      if (url !== 'https://api.github.com/graphql') return json({}, 404);
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { login: string; cursor: string | null } };
      expect(query).toContain('organization(login: $login)');
      expect(variables.login).toBe('acme-corp');
      const page = (nodes: unknown[], next: string | null) =>
        json({ data: { organization: { projectsV2: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } } });
      return variables.cursor === null
        ? page([{ id: 'PVT_1', number: 1, title: 'Roadmap', shortDescription: null, url: 'https://github.com/orgs/acme-corp/projects/1', closed: false }], 'c1')
        : page([{ id: 'PVT_2', number: 2, title: 'Bugs', shortDescription: 'Triage', url: 'https://github.com/orgs/acme-corp/projects/2', closed: true }], null);
    });
    const res = await app()(`${BASE}/projects/available`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; pagination: { totalCount: number } };
    expect(body.data.map((p) => p.nodeId)).toEqual(['PVT_1', 'PVT_2']);
    expect(body.data[1]).toEqual({
      nodeId: 'PVT_2',
      number: 2,
      title: 'Bugs',
      ownerType: 'org',
      ownerLogin: 'acme-corp',
      url: 'https://github.com/orgs/acme-corp/projects/2',
      shortDescription: 'Triage',
      closed: true,
    });
    expect(body.pagination.totalCount).toBe(2);
  });

  it('answers 500 when GraphQL reports errors', async () => {
    await clearConnections();
    await seedConnection({ installationId: 6102, ownerType: 'user', ownerLogin: 'jane' });
    stubGithub((url) => (url === 'https://api.github.com/graphql' ? json({ errors: [{ message: 'Resource not accessible' }] }) : json({}, 404)));
    const res = await app()(`${BASE}/projects/available`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Failed to list available projects');
  });

  it('reads a Project’s Status field', async () => {
    await clearConnections();
    await seedConnection({ installationId: 6103 });
    stubGithub((url, init) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { id: string } };
      if (url !== 'https://api.github.com/graphql') return json({}, 404);
      return variables.id === 'PVT_with'
        ? json({ data: { node: { field: { id: 'PVTSSF_1', name: 'Status', options: [{ id: 'o1', name: 'Todo', color: 'GRAY' }, { id: 'o2', name: 'Done' }] } } } })
        : json({ data: { node: { field: null } } });
    });
    let res = await app()(`${BASE}/projects/status-fields?nodeId=PVT_with`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      fieldId: 'PVTSSF_1',
      fieldName: 'Status',
      options: [
        { id: 'o1', name: 'Todo' },
        { id: 'o2', name: 'Done' },
      ],
    });

    // A second installation: the first one's token is cached now.
    await clearConnections();
    await seedConnection({ installationId: 6104 });
    res = await app()(`${BASE}/projects/status-fields?nodeId=PVT_without`);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ fieldId: null, fieldName: null, options: [] });
  });

  it('refuses a status-field read without a node id', async () => {
    const res = await app()(`${BASE}/projects/status-fields`);
    expect(res.status).toBe(400);
  });

  it('answers 404 for Projects without an active connection', async () => {
    await clearConnections();
    let res = await app()(`${BASE}/projects/available`);
    expect(res.status).toBe(404);
    res = await app()(`${BASE}/projects/status-fields?nodeId=PVT_x`);
    expect(res.status).toBe(404);
  });
});
