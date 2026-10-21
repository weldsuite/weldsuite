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

describe('GET|PUT /api/files/:id/content · tenant keys (TASK-620)', () => {
  const OWN = 'workspaces/org_test_default/drive/general/1_a/own.txt';
  const FOREIGN = 'workspaces/org_victim/drive/general/1_b/payroll.txt';
  const objects = new Map<string, string>([[OWN, 'mine'], [FOREIGN, 'theirs']]);
  const bucket = {
    head: async (k: string) => (objects.has(k) ? { key: k } : null),
    get: async (k: string) =>
      objects.has(k) ? { body: objects.get(k), size: objects.get(k)!.length, httpMetadata: {} } : null,
    put: async (k: string, body: ArrayBuffer) => {
      objects.set(k, new TextDecoder().decode(body));
      return { key: k };
    },
  } as unknown as R2Bucket;
  const withStorage = () =>
    createTestApp('/api/files', filesRoutes, {
      context: {
        tenantDb: db,
        userId: 'user_test',
        permissions: permissions('files:read', 'files:create', 'files:update'),
      },
      env: { PRIVATE_STORAGE: bucket } as never,
    });
  const create = async (storagePath: string) => {
    const res = await withStorage().request('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: `${storagePath.split('/').pop()}`, mimeType: 'text/plain', fileSize: 4, storagePath, fileKey: storagePath }),
    });
    return ((await res.json()) as { data: FileRow }).data;
  };

  it("serves the caller's own workspace key", async () => {
    const row = await create(OWN);
    const res = await withStorage().request(`/api/files/${row.id}/content`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('mine');
  });

  it("refuses a row that points at another workspace's key", async () => {
    const row = await create(FOREIGN);
    expect((await withStorage().request(`/api/files/${row.id}/content`)).status).toBe(404);
    const put = await withStorage().request(`/api/files/${row.id}/content`, { method: 'PUT', body: 'pwned' });
    expect(put.status).toBe(404);
    expect(objects.get(FOREIGN)).toBe('theirs');
  });
});
