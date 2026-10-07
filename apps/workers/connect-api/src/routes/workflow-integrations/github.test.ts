/**
 * DB-backed integration tests for GitHub on `/api/workflow-integrations` —
 * the `app_installation` auth path (no OAuth redirect): `POST /github/link`
 * reuses WeldFlow's existing `github_connections` installation, `/:id/test`
 * and `/:id/github/repos` mint a fresh installation token per call.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { workflowIntegrationsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../../types';

const { privateKey: GITHUB_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

/** Stubs the installation-token exchange with a fixed success; `impl` handles
 *  everything else (repo listing, or nothing at all for a pure mint test). */
function stubGithub(impl: (url: string, init?: RequestInit) => Response | Promise<Response> = () => new Response('{}')) {
  return stubFetch((url, init) => {
    if (url.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({ token: 'ghs_installation_token', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201 },
      );
    }
    return impl(url, init);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app() {
  return createTestApp<Env, Variables>('/api/workflow-integrations', workflowIntegrationsRoutes, {
    context: {
      permissions: permissions('integrations:read', 'integrations:create', 'integrations:update', 'integrations:delete'),
      tenantDb: db,
    },
    env: {
      WORKSPACE_CACHE: fakeKv(),
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY,
    },
  }).request;
}

/** Minimal in-memory KV stand-in — get/put/delete is all these routes use. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

describe('POST /github/link', () => {
  it('returns needs_install when the workspace has no GitHub App installation', async () => {
    const res = await app()('/api/workflow-integrations/github/link', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; provider: string } };
    expect(body.data).toEqual({ status: 'needs_install', provider: 'github' });
  });

  it('links the existing installation into a connected workflow_integrations row', async () => {
    await db.insert(schema.githubConnections).values({
      id: generateId('ghc'),
      workspaceId: 'org_test_default',
      installationId: 42,
      appSlug: 'weldsuite',
      ownerType: 'org',
      ownerLogin: 'acme-corp',
      status: 'active',
    });

    const res = await app()('/api/workflow-integrations/github/link', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; status: string; provider: string } };
    expect(body.data.status).toBe('connected');

    const [row] = await db
      .select()
      .from(schema.workflowIntegrations)
      .where(eq(schema.workflowIntegrations.id, body.data.id));
    expect(row.type).toBe('github');
    expect(row.status).toBe('connected');
    expect((row.settings as { installationId?: number; ownerLogin?: string } | null)?.installationId).toBe(42);
    expect((row.settings as { ownerLogin?: string } | null)?.ownerLogin).toBe('acme-corp');
  });

  it('refuses an unknown provider', async () => {
    const res = await app()('/api/workflow-integrations/not-a-real-provider/link', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('refuses a provider that is not app_installation-kind', async () => {
    const res = await app()('/api/workflow-integrations/slack/link', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('connected GitHub integration · test + repo picker', () => {
  async function seedConnectedGithub(installationId = 777): Promise<string> {
    const id = generateId('int');
    await db.insert(schema.workflowIntegrations).values({
      id,
      name: 'GitHub',
      type: 'github',
      category: 'developer',
      status: 'connected',
      settings: { installationId, ownerLogin: 'acme-corp', ownerType: 'org', appSlug: 'weldsuite' },
      connectedAt: new Date(),
    });
    return id;
  }

  it('POST /:id/test mints an installation token and reports success', async () => {
    const id = await seedConnectedGithub(1001);
    const { calls } = stubGithub();
    const res = await app()(`/api/workflow-integrations/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { success: boolean; message: string } };
    expect(body.data.success).toBe(true);
    expect(body.data.message).toContain('acme-corp');
    expect(calls[0].url).toBe('https://api.github.com/app/installations/1001/access_tokens');
  });

  it('POST /:id/test reports failure when the installation token mint fails', async () => {
    const id = await seedConnectedGithub(1002);
    stubFetch(() => new Response('installation suspended', { status: 403 }));
    const res = await app()(`/api/workflow-integrations/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { success: boolean; message: string } };
    expect(body.data.success).toBe(false);
    expect(body.data.message).toContain('403');
  });

  it('GET /:id/github/repos lists repositories visible to the installation', async () => {
    const id = await seedConnectedGithub(1003);
    stubGithub((url) => {
      if (url.includes('/installation/repositories')) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            repositories: [{ id: 55, full_name: 'acme-corp/widgets', default_branch: 'main', private: false }],
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });

    const res = await app()(`/api/workflow-integrations/${id}/github/repos`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: number; fullName: string; defaultBranch: string; private: boolean }> };
    expect(body.data).toEqual([{ id: 55, fullName: 'acme-corp/widgets', defaultBranch: 'main', private: false }]);
  });

  it('GET /:id/github/repos surfaces a GitHub API error', async () => {
    const id = await seedConnectedGithub(1004);
    stubGithub(() => new Response('bad credentials', { status: 401 }));
    const res = await app()(`/api/workflow-integrations/${id}/github/repos`);
    expect(res.status).toBe(500);
  });

  it('GET /:id/github/repos 400s for a non-GitHub integration', async () => {
    const id = generateId('int');
    await db.insert(schema.workflowIntegrations).values({ id, name: 'Some Webhook', type: 'http', status: 'connected' });
    const res = await app()(`/api/workflow-integrations/${id}/github/repos`);
    expect(res.status).toBe(400);
  });

  it('GET /:id/github/repos 404s for a missing integration', async () => {
    const res = await app()('/api/workflow-integrations/int_missing/github/repos');
    expect(res.status).toBe(404);
  });
});
