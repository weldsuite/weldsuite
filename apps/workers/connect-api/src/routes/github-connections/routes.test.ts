/**
 * The generic object routes `/api/github-connections` and
 * `/api/github-repo-links` on pglite, through the test app (so the
 * conformance harness runs them against both backends): keyset pages with
 * filters, reads without the webhook secret, passthrough creates and
 * updates, and soft deletes. A GitHub connection is a WeldMerge connection
 * (`merge_connections`, provider `github`): the routes answer it in the shape
 * they always had and map a body in that shape back to the columns.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { githubConnectionsRoutes } from './index';
import { githubRepoLinksRoutes } from '../github-repo-links';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const CONNECTIONS = '/api/github-connections';
const REPO_LINKS = '/api/github-repo-links';
const ALL = permissions('integrations:read', 'integrations:create', 'integrations:update', 'integrations:delete');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function connections(granted = ALL) {
  return createTestApp<Env, Variables>(CONNECTIONS, githubConnectionsRoutes, {
    context: { permissions: granted, tenantDb: db },
  }).request;
}

function repoLinks(granted = ALL) {
  return createTestApp<Env, Variables>(REPO_LINKS, githubRepoLinksRoutes, {
    context: { permissions: granted, tenantDb: db },
  }).request;
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function seedConnection(id: string, createdAt: Date, over: Partial<typeof schema.mergeConnections.$inferInsert> = {}) {
  await db.insert(schema.mergeConnections).values({
    id,
    provider: 'github',
    externalAccountId: String(Number(id.replace(/\D/g, '')) + 10_000),
    appSlug: 'weldsuite-test',
    accountType: 'organization',
    accountLogin: `owner-${id}`,
    webhookSecret: 'sealed',
    status: 'active',
    createdByUserId: 'user_seed',
    createdAt,
    updatedAt: createdAt,
    ...over,
  });
}

describe('/api/github-connections', () => {
  it('pages newest first, filters by status and hides the webhook secret', async () => {
    await db.delete(schema.githubRepoLinks);
    await db.delete(schema.mergeConnections);
    await seedConnection('ghc_g1', new Date('2026-01-01T00:00:00.000Z'));
    await seedConnection('ghc_g2', new Date('2026-01-02T00:00:00.000Z'), { status: 'revoked' });
    await seedConnection('ghc_g3', new Date('2026-01-03T00:00:00.000Z'));
    await seedConnection('ghc_g4', new Date('2026-01-03T00:00:00.000Z'));
    await seedConnection('ghc_g5', new Date('2026-01-04T00:00:00.000Z'), { deletedAt: new Date() });

    let res = await connections()(CONNECTIONS);
    expect(res.status).toBe(200);
    let body = (await res.json()) as { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    expect(body.data.map((r) => r.id)).toEqual(['ghc_g4', 'ghc_g3', 'ghc_g2', 'ghc_g1']);
    expect(body.data[0]).not.toHaveProperty('webhookSecret');
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });

    res = await connections()(`${CONNECTIONS}?limit=2`);
    body = (await res.json()) as typeof body;
    expect(body.data.map((r) => r.id)).toEqual(['ghc_g4', 'ghc_g3']);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'ghc_g3' });

    res = await connections()(`${CONNECTIONS}?limit=2&cursor=ghc_g4`);
    body = (await res.json()) as typeof body;
    expect(body.data.map((r) => r.id)).toEqual(['ghc_g3', 'ghc_g2']);
    expect(body.pagination.totalCount).toBe(4);

    res = await connections()(`${CONNECTIONS}?status=active`);
    body = (await res.json()) as typeof body;
    expect(body.data.map((r) => r.id)).toEqual(['ghc_g4', 'ghc_g3', 'ghc_g1']);
    expect(body.pagination.totalCount).toBe(3);

    // A cursor whose row is gone: no keyset, and the count drops the last filter.
    res = await connections()(`${CONNECTIONS}?status=active&cursor=ghc_gone`);
    body = (await res.json()) as typeof body;
    expect(body.data.map((r) => r.id)).toEqual(['ghc_g4', 'ghc_g3', 'ghc_g1']);
    expect(body.pagination.totalCount).toBe(4);

    res = await connections()(`${CONNECTIONS}/ghc_g1`);
    expect(res.status).toBe(200);
    const row = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(row).toMatchObject({ id: 'ghc_g1', installationId: 10_001, ownerType: 'org', ownerLogin: 'owner-ghc_g1', createdBy: 'user_seed', deletedAt: null });
    expect(row).not.toHaveProperty('webhookSecret');

    res = await connections()(`${CONNECTIONS}/ghc_g5`);
    expect(res.status).toBe(404);
  });

  it('never creates a connection: the install flow binds the installation', async () => {
    await db.delete(schema.githubRepoLinks);
    await db.delete(schema.mergeConnections);
    // Another workspace's installation id, made active: refused, nothing written.
    const res = await connections()(
      CONNECTIONS,
      send('POST', {
        installationId: '31337',
        workspaceId: 'org_test_default',
        appSlug: 'weldsuite-test',
        ownerType: 'user',
        ownerLogin: 'jane',
        status: 'active',
        webhookSecret: 'plain',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'A GitHub connection is created by installing the GitHub App' },
    });
    expect(await db.select().from(schema.mergeConnections)).toHaveLength(0);
  });

  it('updates the descriptive fields, refuses the install-flow ones and deletes', async () => {
    await seedConnection('ghc_u1', new Date('2026-01-05T00:00:00.000Z'));
    const id = 'ghc_u1';

    let res = await connections()(
      `${CONNECTIONS}/${id}`,
      send('PATCH', { ownerType: 'user', ownerLogin: 'jane-2', accountLogin: 'not-a-column', workspaceId: 'org_x' }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe(id);
    let [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, id));
    expect(row).toMatchObject({ accountType: 'user', accountLogin: 'jane-2', status: 'active', externalAccountId: '10001' });

    for (const body of [{ installationId: '31337' }, { installationId: null }, { status: 'active' }, { webhookSecret: 'plain', ownerLogin: 'x' }]) {
      res = await connections()(`${CONNECTIONS}/${id}`, send('PATCH', body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'installationId, status and webhookSecret are set by the GitHub App install flow' },
      });
    }
    [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, id));
    expect(row).toMatchObject({ externalAccountId: '10001', status: 'active', webhookSecret: 'sealed', accountLogin: 'jane-2' });

    res = await connections()(`${CONNECTIONS}/${id}`, send('PATCH', { revokedAt: '2026-01-01T00:00:00Z' }));
    expect(res.status).toBe(500);

    res = await connections()(`${CONNECTIONS}/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    res = await connections()(`${CONNECTIONS}/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    res = await connections()(`${CONNECTIONS}/${id}`, send('PATCH', { ownerLogin: 'jane-3' }));
    expect(res.status).toBe(404);
  });

  it('validates the body before refusing it', async () => {
    let res = await connections()(CONNECTIONS, send('POST', { installationId: 12 }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('installing the GitHub App');
    res = await connections()(CONNECTIONS, send('POST', { status: 'x'.repeat(31) }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('installing the GitHub App');
  });

  it('refuses a caller without the permission', async () => {
    const res = await connections(permissions('integrations:read'))(CONNECTIONS, send('POST', {}));
    expect(res.status).toBe(403);
  });
});

describe('/api/github-repo-links', () => {
  it('creates, filters, reads, updates and deletes links', async () => {
    await db.delete(schema.githubRepoLinks);
    await db.delete(schema.mergeConnections);
    await seedConnection('ghc_r1', new Date('2026-02-01T00:00:00.000Z'));
    await seedConnection('ghc_r2', new Date('2026-02-02T00:00:00.000Z'));

    let res = await repoLinks()(
      REPO_LINKS,
      send('POST', {
        connectionId: 'ghc_r1',
        repoFullName: 'acme-corp/api',
        projectId: 'prj_r',
        workspaceId: 'org_test_default',
        repoId: 501,
        isActive: true,
      }),
    );
    expect(res.status).toBe(201);
    const first = ((await res.json()) as { data: { id: string } }).data.id;

    res = await repoLinks()(
      REPO_LINKS,
      send('POST', { connectionId: 'ghc_r2', repoFullName: 'acme-corp/web', workspaceId: 'org_test_default', repoId: 502 }),
    );
    expect(res.status).toBe(201);

    res = await repoLinks()(REPO_LINKS);
    let body = (await res.json()) as { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    expect(body.data).toHaveLength(2);
    expect(body.pagination.totalCount).toBe(2);

    res = await repoLinks()(`${REPO_LINKS}?connectionId=ghc_r1`);
    body = (await res.json()) as typeof body;
    expect(body.data.map((r) => r.id)).toEqual([first]);
    expect(body.data[0]).toMatchObject({ repoId: 501, projectId: 'prj_r', syncIssues: true, syncDirection: 'bidirectional' });

    res = await repoLinks()(`${REPO_LINKS}?projectId=prj_none`);
    body = (await res.json()) as typeof body;
    expect(body.data).toEqual([]);

    res = await repoLinks()(`${REPO_LINKS}/${first}`, send('PATCH', { projectId: null, syncDirection: 'inbound' }));
    expect(res.status).toBe(200);
    res = await repoLinks()(`${REPO_LINKS}/${first}`);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({ projectId: null, syncDirection: 'inbound' });

    res = await repoLinks()(`${REPO_LINKS}/${first}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    res = await repoLinks()(`${REPO_LINKS}/${first}`);
    expect(res.status).toBe(404);
  });

  it('validates the body', async () => {
    let res = await repoLinks()(REPO_LINKS, send('POST', { repoFullName: 'acme-corp/api' }));
    expect(res.status).toBe(400);
    res = await repoLinks()(REPO_LINKS, send('POST', { connectionId: 'ghc_r1', repoFullName: '' }));
    expect(res.status).toBe(400);
    res = await repoLinks()(`${REPO_LINKS}/ghr_x`, send('PATCH', { isActive: 'yes' }));
    expect(res.status).toBe(400);
    res = await repoLinks()(`${REPO_LINKS}/ghr_x`, send('PATCH', { repoFullName: 'acme-corp/x' }));
    expect(res.status).toBe(404);
  });
});
