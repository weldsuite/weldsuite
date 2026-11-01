/**
 * The generic object routes `/api/github-connections` and
 * `/api/github-repo-links` on pglite, through the test app (so the
 * conformance harness runs them against both backends): keyset pages with
 * filters, reads without the webhook secret, passthrough creates and
 * updates, and soft deletes.
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

async function seedConnection(id: string, createdAt: Date, over: Partial<typeof schema.githubConnections.$inferInsert> = {}) {
  await db.insert(schema.githubConnections).values({
    id,
    workspaceId: 'org_test_default',
    installationId: Number(id.replace(/\D/g, '')) + 10_000,
    appSlug: 'weldsuite-test',
    ownerType: 'org',
    ownerLogin: `owner-${id}`,
    webhookSecret: 'sealed',
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    ...over,
  });
}

describe('/api/github-connections', () => {
  it('pages newest first, filters by status and hides the webhook secret', async () => {
    await db.delete(schema.githubRepoLinks);
    await db.delete(schema.githubConnections);
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
    expect(row).toMatchObject({ id: 'ghc_g1', installationId: 10_001, ownerLogin: 'owner-ghc_g1', deletedAt: null });
    expect(row).not.toHaveProperty('webhookSecret');

    res = await connections()(`${CONNECTIONS}/ghc_g5`);
    expect(res.status).toBe(404);
  });

  it('creates, updates and deletes through the passthrough body', async () => {
    let res = await connections()(
      CONNECTIONS,
      send('POST', {
        installationId: '31337',
        workspaceId: 'org_test_default',
        appSlug: 'weldsuite-test',
        ownerType: 'user',
        ownerLogin: 'jane',
        accountLogin: 'not-a-column',
      }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    let [row] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.id, id));
    expect(row).toMatchObject({ installationId: 31337, ownerLogin: 'jane', status: 'active' });

    res = await connections()(`${CONNECTIONS}/${id}`, send('PATCH', { status: 'suspended', ownerLogin: 'jane-2' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe(id);
    [row] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.id, id));
    expect(row).toMatchObject({ status: 'suspended', ownerLogin: 'jane-2' });

    res = await connections()(`${CONNECTIONS}/${id}`, send('PATCH', { revokedAt: '2026-01-01T00:00:00Z' }));
    expect(res.status).toBe(500);

    res = await connections()(`${CONNECTIONS}/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    res = await connections()(`${CONNECTIONS}/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    res = await connections()(`${CONNECTIONS}/${id}`, send('PATCH', { status: 'active' }));
    expect(res.status).toBe(404);
  });

  it('validates the body and answers 500 for a row the table refuses', async () => {
    let res = await connections()(CONNECTIONS, send('POST', { installationId: 12 }));
    expect(res.status).toBe(400);
    res = await connections()(CONNECTIONS, send('POST', { status: 'x'.repeat(31) }));
    expect(res.status).toBe(400);
    // No workspace, slug or owner: the insert fails.
    res = await connections()(CONNECTIONS, send('POST', { installationId: '1' }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Failed to create github connection');
  });

  it('refuses a caller without the permission', async () => {
    const res = await connections(permissions('integrations:read'))(CONNECTIONS, send('POST', {}));
    expect(res.status).toBe(403);
  });
});

describe('/api/github-repo-links', () => {
  it('creates, filters, reads, updates and deletes links', async () => {
    await db.delete(schema.githubRepoLinks);
    await db.delete(schema.githubConnections);
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
