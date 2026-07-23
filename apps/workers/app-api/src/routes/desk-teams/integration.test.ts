/**
 * DB-backed integration tests for /api/desk/teams and /api/desk/teammates —
 * proving validation → service → response envelope end to end. Service-level
 * behavior is covered in services/desk/teams-pglite.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskTeamsRoutes, deskTeammatesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function teamsApp(perm: string) {
  return createTestApp('/api/desk/teams', deskTeamsRoutes, {
    context: { permissions: permissions(perm), tenantDb: db },
  }).request;
}

function teammatesApp(perm: string, userId = 'user_test_default') {
  return createTestApp('/api/desk/teammates', deskTeammatesRoutes, {
    context: { permissions: permissions(perm), tenantDb: db, userId },
  }).request;
}

describe('/api/desk/teams · pglite integration', () => {
  it('POST / creates a team', async () => {
    const request = teamsApp('inboxes:create');
    const res = await request('/api/desk/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sales', memberIds: ['user_1'], distributionMethod: 'balanced' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string } };
    expect(body.data.id).toMatch(/^dteam_/);
    expect(body.data.name).toBe('Sales');
  });

  it('GET / excludes archived teams by default, includes with ?archived=true', async () => {
    const createRes = await teamsApp('inboxes:create')('/api/desk/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temp Team', memberIds: [] }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    await teamsApp('inboxes:delete')(`/api/desk/teams/${created.id}`, { method: 'DELETE' });

    const activeRes = await teamsApp('inboxes:read')('/api/desk/teams');
    const activeBody = (await activeRes.json()) as { data: Array<{ id: string }> };
    expect(activeBody.data.some((t) => t.id === created.id)).toBe(false);

    const archivedRes = await teamsApp('inboxes:read')('/api/desk/teams?archived=true');
    const archivedBody = (await archivedRes.json()) as { data: Array<{ id: string; archived: boolean }> };
    expect(archivedBody.data.some((t) => t.id === created.id && t.archived)).toBe(true);
  });

  it('PATCH /:id updates a team', async () => {
    const createRes = await teamsApp('inboxes:create')('/api/desk/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Support', memberIds: [] }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await teamsApp('inboxes:update')(`/api/desk/teams/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamLimit: 25 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { teamLimit: number } }).data.teamLimit).toBe(25);
  });

  it('DELETE /:id archives (204) rather than hard-deleting', async () => {
    const createRes = await teamsApp('inboxes:create')('/api/desk/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To Archive', memberIds: [] }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const delRes = await teamsApp('inboxes:delete')(`/api/desk/teams/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await teamsApp('inboxes:read')(`/api/desk/teams/${created.id}`);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { data: { archived: boolean } }).data.archived).toBe(true);
  });

  it('GET /:id returns 404 for a missing team', async () => {
    const res = await teamsApp('inboxes:read')('/api/desk/teams/dteam_missing');
    expect(res.status).toBe(404);
  });
});

describe('/api/desk/teammates/me · pglite integration', () => {
  it('GET /me returns workspace defaults before any PUT', async () => {
    const res = await teammatesApp('inboxes:read', 'user_fresh_teammate')('/api/desk/teammates/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; userId: string } };
    expect(body.data.status).toBe('active');
    expect(body.data.userId).toBe('user_fresh_teammate');
  });

  it('PUT /me upserts, then GET /me reflects it', async () => {
    const userId = 'user_teammate_route_1';
    const putRes = await teammatesApp('inboxes:read', userId)('/api/desk/teammates/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'away', assignmentLimit: 3 }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { data: { status: string; assignmentLimit: number } };
    expect(putBody.data.status).toBe('away');
    expect(putBody.data.assignmentLimit).toBe(3);

    const getRes = await teammatesApp('inboxes:read', userId)('/api/desk/teammates/me');
    const getBody = (await getRes.json()) as { data: { status: string } };
    expect(getBody.data.status).toBe('away');
  });
});
