/**
 * /api/folders against pglite: a folder can't become its own parent or move
 * under one of its subfolders (it and its contents would vanish from My
 * Drive), and folder names follow the Drive name rules.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { foldersRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

function app() {
  return createTestApp('/api/folders', foldersRoutes, {
    context: {
      tenantDb: db,
      permissions: permissions('folders:read', 'folders:create', 'folders:update'),
    },
  });
}

async function send(method: 'POST' | 'PATCH', path: string, body: unknown) {
  return app().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function create(name: string, parentId?: string): Promise<string> {
  const res = await send('POST', '/api/folders', { name, parentId });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

let parent: string;
let child: string;
let grandchild: string;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  parent = await create('E2E Folder');
  child = await create('E2E Sub', parent);
  grandchild = await create('E2E Sub Sub', child);
}, 60_000);

describe('PATCH /api/folders/:id · parent', () => {
  it('rejects the folder as its own parent', async () => {
    const res = await send('PATCH', `/api/folders/${parent}`, { parentId: parent });
    expect(res.status).toBe(400);
  });

  it('rejects a parent inside the folder', async () => {
    expect((await send('PATCH', `/api/folders/${parent}`, { parentId: child })).status).toBe(400);
    expect((await send('PATCH', `/api/folders/${parent}`, { parentId: grandchild })).status).toBe(400);
  });

  it('rejects a parent that does not exist', async () => {
    const res = await send('PATCH', `/api/folders/${child}`, { parentId: 'fld_missing' });
    expect(res.status).toBe(400);
  });

  it('moves a folder to another folder and back to My Drive', async () => {
    const other = await create('Other');
    const moved = await send('PATCH', `/api/folders/${child}`, { parentId: other });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { data: { parentId: string } }).data.parentId).toBe(other);

    const root = await send('PATCH', `/api/folders/${child}`, { parentId: null });
    expect(root.status).toBe(200);
  });
});

describe('folder names', () => {
  it('rejects path and reserved characters', async () => {
    expect((await send('POST', '/api/folders', { name: 'a/b' })).status).toBe(400);
    expect((await send('PATCH', `/api/folders/${parent}`, { name: 'x:y?' })).status).toBe(400);
  });

  it('trims surrounding whitespace', async () => {
    const res = await send('POST', '/api/folders', { name: '  Contracts  ' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('Contracts');
  });

  it('rejects creating a folder inside one that does not exist', async () => {
    expect((await send('POST', '/api/folders', { name: 'Orphan', parentId: 'fld_missing' })).status).toBe(400);
  });
});
