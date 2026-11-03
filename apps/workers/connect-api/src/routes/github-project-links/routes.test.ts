/**
 * `/api/github-project-links` on pglite, through the test app (so the
 * conformance harness runs it against both backends): linking a WeldFlow
 * project to a GitHub Project (and re-linking it), listing, reading,
 * updating and unlinking links, and starting a sync on `GITHUB_PROJECT_SYNC`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { githubProjectLinksRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const BASE = '/api/github-project-links';
const ORG = 'org_test_default';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app(env: Record<string, unknown> = {}, granted = permissions('integrations:github:manage')) {
  return createTestApp<Env, Variables>(BASE, githubProjectLinksRoutes, {
    context: { permissions: granted, tenantDb: db },
    env: env as never,
  }).request;
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({ ...post(body), method: 'PATCH' });

let seq = 0;

async function seedConnection(status = 'active') {
  const id = `ghc_pl_${++seq}`;
  await db.insert(schema.githubConnections).values({
    id,
    workspaceId: ORG,
    installationId: 700_000 + seq,
    appSlug: 'weldsuite-test',
    ownerType: 'org',
    ownerLogin: 'acme-corp',
    status: status as 'active',
  });
  return id;
}

async function reset() {
  await db.delete(schema.githubProjectLinks);
  await db.delete(schema.githubConnections);
}

const link = (over: Record<string, unknown> = {}) => ({
  projectId: `prj_${++seq}`,
  projectV2NodeId: `PVT_${seq}`,
  projectV2Number: seq,
  ownerType: 'org',
  ownerLogin: 'acme-corp',
  ...over,
});

describe('linking', () => {
  it('links a project with the defaults, and lists, reads, updates and unlinks it', async () => {
    await reset();
    const connectionId = await seedConnection();

    let res = await app()(BASE, post(link({ projectId: 'prj_main', projectTitle: 'Roadmap', extra: true })));
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(created).toMatchObject({
      workspaceId: ORG,
      connectionId,
      projectId: 'prj_main',
      projectTitle: 'Roadmap',
      repoId: null,
      repoFullName: null,
      statusFieldId: null,
      statusOptionMap: [],
      syncIssues: true,
      syncDirection: 'bidirectional',
      lastSyncedAt: null,
      lastError: null,
    });
    const id = created.id as string;

    await app()(
      BASE,
      post(
        link({
          projectId: 'prj_other',
          repoId: 55,
          repoFullName: 'acme-corp/api',
          statusFieldId: 'PVTSSF_1',
          statusOptionMap: [
            { githubOptionId: 'o1', githubOptionName: 'Todo', stageId: 'stage_todo', color: 'GRAY' },
            { githubOptionId: 'o2', githubOptionName: 'Done', stageId: null },
          ],
          syncDirection: 'inbound',
          syncIssues: false,
        }),
      ),
    );

    res = await app()(BASE);
    let list = (await res.json()) as { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    expect(list.data.map((l) => l.projectId).sort()).toEqual(['prj_main', 'prj_other']);
    const other = list.data.find((l) => l.projectId === 'prj_other');
    expect(other?.statusOptionMap).toEqual([
      { githubOptionId: 'o1', githubOptionName: 'Todo', stageId: 'stage_todo' },
      { githubOptionId: 'o2', githubOptionName: 'Done', stageId: null },
    ]);
    expect(list.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });

    res = await app()(`${BASE}?projectId=prj_main`);
    list = (await res.json()) as typeof list;
    expect(list.data.map((l) => l.id)).toEqual([id]);

    res = await app()(`${BASE}?limit=1`);
    list = (await res.json()) as typeof list;
    expect(list.data).toHaveLength(1);
    expect(list.pagination.hasMore).toBe(true);

    res = await app()(`${BASE}/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { projectTitle: string } }).data.projectTitle).toBe('Roadmap');

    res = await app()(
      `${BASE}/${id}`,
      patch({
        projectTitle: 'Roadmap 2',
        statusFieldId: 'PVTSSF_9',
        statusOptionMap: [{ githubOptionId: 'o9', githubOptionName: 'Shipped', stageId: null }],
        syncDirection: 'outbound',
        syncIssues: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      projectTitle: 'Roadmap 2',
      statusFieldId: 'PVTSSF_9',
      statusOptionMap: [{ githubOptionId: 'o9', githubOptionName: 'Shipped', stageId: null }],
      syncDirection: 'outbound',
      syncIssues: false,
    });

    res = await app()(`${BASE}/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    res = await app()(`${BASE}/${id}`);
    expect(res.status).toBe(404);
    res = await app()(`${BASE}/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    res = await app()(`${BASE}/${id}`, patch({ projectTitle: 'x' }));
    expect(res.status).toBe(404);

    // Linking the project again revives its row.
    res = await app()(BASE, post(link({ projectId: 'prj_main', projectV2NodeId: 'PVT_again', projectV2Number: 99 })));
    expect(res.status).toBe(201);
    const revived = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(revived.id).toBe(id);
    expect(revived).toMatchObject({ projectV2NodeId: 'PVT_again', projectV2Number: 99, projectTitle: null });
    const [row] = await db.select().from(schema.githubProjectLinks).where(eq(schema.githubProjectLinks.id, id));
    expect(row.deletedAt).toBeNull();
  });

  it('refuses a link without an active connection', async () => {
    await reset();
    await seedConnection('revoked');
    const res = await app()(BASE, post(link()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'No active GitHub connection. Install the GitHub App first.',
    );
  });

  it('validates the body', async () => {
    await reset();
    await seedConnection();
    for (const body of [
      {},
      link({ projectV2Number: 0 }),
      link({ ownerType: 'team' }),
      link({ statusOptionMap: [{ githubOptionId: 'o1' }] }),
      link({ statusOptionMap: 'nope' }),
      link({ repoId: -1 }),
    ]) {
      const res = await app()(BASE, post(body));
      expect(res.status).toBe(400);
    }
    const res = await app()(`${BASE}/ghpl_missing`, patch({ syncDirection: 'sideways' }));
    expect(res.status).toBe(400);
  });

  it('answers 500 when the GitHub Project is already linked to another project', async () => {
    await reset();
    await seedConnection();
    expect((await app()(BASE, post(link({ projectId: 'prj_a', projectV2NodeId: 'PVT_shared' })))).status).toBe(201);
    const res = await app()(BASE, post(link({ projectId: 'prj_b', projectV2NodeId: 'PVT_shared' })));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Failed to link project');
  });

  it('refuses a caller without integrations:github:manage', async () => {
    const res = await app({}, permissions('integrations:read'))(BASE);
    expect(res.status).toBe(403);
  });
});

describe('POST /:id/sync', () => {
  function binding(fail = false) {
    return {
      create: vi.fn(async (init: { id: string }) => {
        if (fail) throw new Error('instance already exists');
        return { id: init.id };
      }),
      get: vi.fn(async (id: string) => ({ id })),
    };
  }

  it('starts a sync on the binding under a per-minute run id', async () => {
    await reset();
    await seedConnection();
    const created = await app()(BASE, post(link({ projectId: 'prj_sync' })));
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const GITHUB_PROJECT_SYNC = binding();

    const res = await app({ GITHUB_PROJECT_SYNC })(`${BASE}/${id}/sync`, { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { runId: string } };
    expect(data.runId).toMatch(new RegExp(`^github-project-sync-${id}-\\d+$`));
    expect(GITHUB_PROJECT_SYNC.create).toHaveBeenCalledWith({
      id: data.runId,
      params: { workspaceId: ORG, projectLinkId: id },
    });
  });

  it('reuses a run already there', async () => {
    await reset();
    await seedConnection();
    const created = await app()(BASE, post(link({ projectId: 'prj_sync_again' })));
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const res = await app({ GITHUB_PROJECT_SYNC: binding(true) })(`${BASE}/${id}/sync`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('checks the connection, the link and the binding', async () => {
    await reset();
    let res = await app({ GITHUB_PROJECT_SYNC: binding() })(`${BASE}/ghpl_missing/sync`, { method: 'POST' });
    expect(res.status).toBe(400);

    await seedConnection();
    res = await app({ GITHUB_PROJECT_SYNC: binding() })(`${BASE}/ghpl_missing/sync`, { method: 'POST' });
    expect(res.status).toBe(404);

    const created = await app()(BASE, post(link({ projectId: 'prj_unbound' })));
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    res = await app()(`${BASE}/${id}/sync`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'GitHub project-sync workflow binding not configured',
    );
  });
});
