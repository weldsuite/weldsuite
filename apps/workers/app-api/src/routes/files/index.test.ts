/**
 * /api/files against pglite: rename rules (reserved characters, trimming,
 * case-insensitive duplicates) and the Details panel description.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { filesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

interface FileRow {
  id: string;
  fileName: string;
}

interface ListedFile {
  id: string;
  name: string;
  description?: string | null;
}

function app() {
  return createTestApp('/api/files', filesRoutes, {
    context: {
      tenantDb: db,
      userId: 'user_test',
      permissions: permissions('files:read', 'files:create', 'files:update'),
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

async function upload(fileName: string): Promise<FileRow> {
  const res = await send('POST', '/api/files', {
    fileName,
    mimeType: 'text/plain',
    fileSize: 600,
    storagePath: `workspaces/w/${fileName}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: FileRow }).data;
}

const rename = (id: string, fileName: string) => send('PATCH', `/api/files/${id}`, { fileName });

let contract: FileRow;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  contract = await upload('contract-e2e.txt');
}, 60_000);

describe('PATCH /api/files/:id · names', () => {
  it('rejects path and reserved characters', async () => {
    expect((await rename(contract.id, 'a/b.txt')).status).toBe(400);
    expect((await rename(contract.id, 'x/y:z?.txt')).status).toBe(400);
  });

  it('rejects a name that differs from another file only in case', async () => {
    const other = await upload('other-e2e.txt');
    expect((await rename(other.id, 'CONTRACT-E2E.TXT')).status).toBe(409);
  });

  it('trims whitespace, so a trailing space is the same name', async () => {
    const other = await upload('third-e2e.txt');
    expect((await rename(other.id, 'contract-e2e.txt ')).status).toBe(409);
    const res = await rename(other.id, '  renamed-e2e.txt  ');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: FileRow }).data.fileName).toBe('renamed-e2e.txt');
  });
});

describe('POST /api/files · uploaded names', () => {
  it('makes reserved characters in an uploaded name safe instead of refusing it', async () => {
    const row = await upload('a:b?.txt');
    expect(row.fileName).toBe('a_b_.txt');
  });
});

describe('PATCH /api/files/:id · description', () => {
  it('saves the description and lists it with the file', async () => {
    const res = await send('PATCH', `/api/files/${contract.id}`, { description: '<p>Persist test</p>' });
    expect(res.status).toBe(200);

    const list = await app().request('/api/files?pageSize=200');
    const listed = ((await list.json()) as { data: ListedFile[] }).data.find((f) => f.id === contract.id);
    expect(listed?.description).toBe('<p>Persist test</p>');

    await send('PATCH', `/api/files/${contract.id}`, { description: null });
    const after = await app().request('/api/files?pageSize=200');
    const cleared = ((await after.json()) as { data: ListedFile[] }).data.find((f) => f.id === contract.id);
    expect(cleared?.description).toBeNull();
  });
});
