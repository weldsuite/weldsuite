/**
 * DB-backed integration tests for label name uniqueness on /api/project-labels.
 * "Bug" and "bug" used to both be created; names now compare case-insensitively
 * and ignoring surrounding whitespace.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { projectLabelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function send(method: string, path: string, body?: unknown) {
  const { request } = createTestApp('/api/project-labels', projectLabelsRoutes, {
    context: {
      permissions: permissions('projects:read', 'projects:create', 'projects:update'),
      tenantDb: db,
    },
  });
  return request(`/api/project-labels${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/project-labels · duplicate names', () => {
  it('rejects a label whose name only differs by case or whitespace', async () => {
    const first = await send('POST', '', { name: 'Bug', color: '#ff0000' });
    expect(first.status).toBe(201);

    const lower = await send('POST', '', { name: 'bug', color: '#00ff00' });
    expect(lower.status).toBe(409);

    const padded = await send('POST', '', { name: '  BUG  ', color: '#0000ff' });
    expect(padded.status).toBe(409);
  });

  it('trims the stored name', async () => {
    const res = await send('POST', '', { name: '  Spaced  ', color: '#ff0000' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).toBe('Spaced');
  });

  it('rejects a whitespace-only name', async () => {
    const res = await send('POST', '', { name: '   ', color: '#ff0000' });
    expect(res.status).toBe(400);
  });

  it('rejects renaming a label onto an existing name, but allows keeping its own', async () => {
    const a = (await (await send('POST', '', { name: 'Alpha', color: '#ff0000' })).json()) as { data: { id: string } };
    await send('POST', '', { name: 'Beta', color: '#ff0000' });

    const clash = await send('PATCH', `/${a.data.id}`, { name: 'beta' });
    expect(clash.status).toBe(409);

    const same = await send('PATCH', `/${a.data.id}`, { name: 'ALPHA' });
    expect(same.status).toBe(200);
  });
});

describe('/api/project-labels · reads and delete', () => {
  const remove = (id: string) =>
    createTestApp('/api/project-labels', projectLabelsRoutes, {
      context: { permissions: permissions('projects:read', 'projects:delete'), tenantDb: db },
    }).request(`/api/project-labels/${id}`, { method: 'DELETE' });

  it('lists, reads and deletes a workspace label', async () => {
    const created = await send('POST', '', { name: 'Gamma', color: '#123456' });
    const { data } = (await created.json()) as { data: { id: string } };

    const list = await send('GET', '?limit=50');
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: Array<{ id: string }> };
    expect(listed.data.map((label) => label.id)).toContain(data.id);

    const read = await send('GET', `/${data.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { data: { name: string } }).data.name).toBe('Gamma');
    expect((await send('GET', '/plbl_missing')).status).toBe(404);

    expect((await remove(data.id)).status).toBe(204);
    expect((await send('GET', `/${data.id}`)).status).toBe(404);
    expect((await remove(data.id)).status).toBe(404);
  });
});
