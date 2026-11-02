/**
 * /api/documents against a WeldDocs document (a `docs` row docs-api owns).
 *
 * These endpoints store BlockNote JSON. A WeldDocs document keeps its content
 * in its DocRoom, so they read it as an empty document and refuse every write
 * with a 409: nothing here may put BlockNote JSON into such a row.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { documentsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const ALICE = 'user_alice';
const BLOCKS = [{ type: 'paragraph', content: 'Hello' }];

let db: Database;

function send(method: string, path: string, body?: unknown): Promise<Response> {
  const { request } = createTestApp('/api/documents', documentsRoutes, {
    context: { userId: ALICE, permissions: permissions('files:read', 'files:create', 'files:update'), tenantDb: db },
  });
  return Promise.resolve(
    request(`/api/documents${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function seedFile(id: string): Promise<void> {
  await db.insert(schema.files).values({
    id,
    fileName: `${id}.docx`,
    mimeType: 'x',
    fileSize: 1,
    fileType: 'document',
    storagePath: `k/${id}`,
    uploadedById: ALICE,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedFile('fil_old');
  await db.insert(schema.docs).values({ id: 'doc_old', fileId: 'fil_old', content: BLOCKS });
  await seedFile('fil_new');
  // What docs-api writes: no BlockNote content, a checkpoint key.
  await db.insert(schema.docs).values({ id: 'doc_new', fileId: 'fil_new', content: null, snapshotKey: 'workspaces/w/docs/doc_new/document.json.gz' });
}, 60_000);

describe('/api/documents with a document from before WeldDocs', () => {
  it('still reads and saves BlockNote content', async () => {
    const read = await send('GET', '/fil_old');
    expect(((await read.json()) as { data: { content: unknown } }).data.content).toEqual(BLOCKS);
    const saved = await send('PUT', '/fil_old/content', { content: [] });
    expect(saved.status).toBe(200);
    const [row] = await db.select().from(schema.docs).where(eq(schema.docs.id, 'doc_old'));
    expect(row!.content).toEqual([]);
  });
});

describe('/api/documents with a WeldDocs document', () => {
  it('reads it as an empty document', async () => {
    const res = await send('GET', '/fil_new');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string; content: unknown } }).data).toMatchObject({ id: 'doc_new', content: [] });
  });

  it.each([
    ['saving content', 'PUT', '/fil_new/content', { content: BLOCKS }],
    ['naming a version', 'POST', '/fil_new/versions', {}],
  ])('refuses %s with a 409 and leaves the row alone', async (_label, method, path, body) => {
    const res = await send(method, path, body);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('WeldDocs'),
    });
    const [row] = await db.select().from(schema.docs).where(eq(schema.docs.id, 'doc_new'));
    expect(row!.content).toBeNull();
    expect(await db.select().from(schema.documentVersions).where(eq(schema.documentVersions.fileId, 'fil_new'))).toEqual([]);
  });

  it('refuses to restore a version over it', async () => {
    await db.insert(schema.documentVersions).values({ id: 'docver_1', fileId: 'fil_new', content: BLOCKS });
    expect((await send('POST', '/fil_new/versions/docver_1/restore')).status).toBe(409);
    const [row] = await db.select().from(schema.docs).where(eq(schema.docs.id, 'doc_new'));
    expect(row!.content).toBeNull();
  });
});
