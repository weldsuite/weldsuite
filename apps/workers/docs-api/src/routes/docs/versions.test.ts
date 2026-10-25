import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { docVersions, docs, files } from '@weldsuite/db/schema';
import type { DocRestoreResult, DocSummary, DocVersion } from '@weldsuite/app-api-client/schemas/docs';
import { DocModel, applyOp } from '@weldsuite/docs-engine';
import type { Env, Variables } from '../../types';
import { writeSnapshot } from '../../room/snapshot';
import { versionKeyFor } from '../../services/versions';
import { FakeBucket, fakeRoomNamespace } from '../../test-support/fakes';
import docRoutes from './index';

const ALL = ['docs:read', 'docs:create', 'docs:update', 'docs:delete'];
const ALICE = 'user_alice';
const BOB = 'user_bob';

let db: Database;
let bucket: FakeBucket;
let rooms: ReturnType<typeof fakeRoomNamespace>;

function app(options: { userId?: string; keys?: string[] } = {}) {
  return createTestApp<Env, Variables>('/api/docs', docRoutes, {
    context: { tenantDb: db, permissions: permissions(...(options.keys ?? ALL)), userId: options.userId ?? ALICE },
    env: { PRIVATE_STORAGE: bucket.asBinding(), DOC_ROOM: rooms.binding },
  });
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function create(name: string): Promise<DocSummary> {
  const res = await app().request('/api/docs', json('POST', { name }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: DocSummary }).data;
}

async function saveVersion(doc: DocSummary, name: string, userId = ALICE): Promise<DocVersion> {
  const res = await app({ userId }).request(`/api/docs/${doc.id}/versions`, json('POST', { name }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: DocVersion }).data;
}

const docKey = (doc: DocSummary) => `workspaces/org_test_default/docs/${doc.id}/document.json.gz`;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(docVersions);
  await db.delete(docs);
  await db.delete(files);
  bucket = new FakeBucket();
  rooms = fakeRoomNamespace(() => db);
});

describe('/api/docs/:id/versions', () => {
  it('saves the live document as a named version next to the document', async () => {
    const doc = await create('Plan');
    const version = await saveVersion(doc, 'First draft');
    expect(version).toMatchObject({ docId: doc.id, name: 'First draft', revision: 7, createdById: ALICE });
    expect(version.id).toMatch(/^docv_/);

    const key = `workspaces/org_test_default/docs/${doc.id}/versions/${version.id}.json.gz`;
    expect(versionKeyFor(docKey(doc), version.id)).toBe(key);
    expect(rooms.saved).toEqual([
      { name: `org_test_default:${doc.id}`, doc: { workspaceId: 'org_test_default', docId: doc.id, snapshotKey: docKey(doc) }, key },
    ]);
    const [row] = await db.select().from(docVersions).where(eq(docVersions.id, version.id));
    expect(row).toMatchObject({ snapshotKey: key, revision: 7, name: 'First draft' });

    expect((await app().request(`/api/docs/${doc.id}/versions`, json('POST', { name: '  ' }))).status).toBe(400);
    expect((await app().request('/api/docs/doc_nope/versions', json('POST', { name: 'x' }))).status).toBe(404);
  });

  it('lists versions newest first, a page at a time', async () => {
    const doc = await create('Paged');
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 10, minute));
    await db.insert(docVersions).values(
      [1, 2, 3].map((n) => ({ id: `docv_${n}`, docId: doc.id, revision: n, name: `v${n}`, snapshotKey: `k${n}`, createdAt: at(n) })),
    );
    // Another document's versions stay out.
    const other = await create('Other');
    await db.insert(docVersions).values({ id: 'docv_other', docId: other.id, revision: 1, snapshotKey: 'k', createdAt: at(9) });

    type Page = { data: DocVersion[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    const first = (await (await app().request(`/api/docs/${doc.id}/versions?limit=2`)).json()) as Page;
    expect(first.data.map((v) => v.id)).toEqual(['docv_3', 'docv_2']);
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'docv_2' });
    const rest = (await (await app().request(`/api/docs/${doc.id}/versions?limit=2&cursor=docv_2`)).json()) as Page;
    expect(rest.data.map((v) => v.id)).toEqual(['docv_1']);
    expect(rest.pagination).toMatchObject({ hasMore: false, cursor: null });
    const unknown = (await (await app().request(`/api/docs/${doc.id}/versions?cursor=docv_other`)).json()) as Page;
    expect(unknown.data).toEqual([]);
  });

  it('renames a version', async () => {
    const doc = await create('Named');
    const version = await saveVersion(doc, 'Before');
    const res = await app().request(`/api/docs/${doc.id}/versions/${version.id}`, json('PATCH', { name: 'After' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: DocVersion }).data.name).toBe('After');
    expect((await app().request(`/api/docs/${doc.id}/versions/docv_nope`, json('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await app().request(`/api/docs/${doc.id}/versions/${version.id}`, json('PATCH', {}))).status).toBe(400);
    // A version is only found through its own document.
    const other = await create('Other');
    expect((await app().request(`/api/docs/${other.id}/versions/${version.id}`, json('PATCH', { name: 'x' }))).status).toBe(404);
  });

  it('serves a version\'s snapshot, never cached', async () => {
    const doc = await create('Snap');
    const version = await saveVersion(doc, 'Saved');
    const saved = DocModel.create();
    applyOp(saved, { type: 'insert', story: 'body', at: 0, content: { text: 'Back then' } });
    await writeSnapshot(bucket.asBinding(), rooms.saved[0]!.key, { revision: 7, doc: saved.toSnapshot() });

    const res = await app({ keys: ['docs:read'] }).request(`/api/docs/${doc.id}/versions/${version.id}/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ data: { revision: 7, snapshot: saved.toSnapshot() } });
    expect((await app().request(`/api/docs/${doc.id}/versions/docv_nope/snapshot`)).status).toBe(404);
  });

  it('restores a version, saving the document as it was first', async () => {
    const doc = await create('Restore me');
    const version = await saveVersion(doc, 'Good one');
    const res = await app().request(`/api/docs/${doc.id}/versions/${version.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const result = ((await res.json()) as { data: DocRestoreResult }).data;
    expect(result.revision).toBe(8);
    expect(result.autoVersion).toMatchObject({ docId: doc.id, name: null, revision: 7, createdById: ALICE });
    expect(rooms.restores[0]!.request).toEqual({
      doc: { workspaceId: 'org_test_default', docId: doc.id, snapshotKey: docKey(doc) },
      versionId: version.id,
      versionKey: versionKeyFor(docKey(doc), version.id),
      autoVersionId: result.autoVersion.id,
      userId: ALICE,
    });

    const list = (await (await app().request(`/api/docs/${doc.id}/versions`)).json()) as { data: DocVersion[] };
    expect(new Set(list.data.map((v) => v.name))).toEqual(new Set(['Good one', null]));
    expect((await app().request(`/api/docs/${doc.id}/versions/docv_nope/restore`, { method: 'POST' })).status).toBe(404);

    // A version whose snapshot is gone cannot be restored.
    rooms.live.missingVersion = true;
    expect((await app().request(`/api/docs/${doc.id}/versions/${version.id}/restore`, { method: 'POST' })).status).toBe(404);
  });

  it('lets viewers look at versions but not save, rename or restore them', async () => {
    const doc = await create('Shared');
    const version = await saveVersion(doc, 'Mine');
    await db.update(files).set({ generalAccess: 'workspace_view' }).where(eq(files.id, doc.fileId));
    await writeSnapshot(bucket.asBinding(), rooms.saved[0]!.key, { revision: 7, doc: DocModel.create().toSnapshot() });

    const bob = app({ userId: BOB });
    expect((await bob.request(`/api/docs/${doc.id}/versions`)).status).toBe(200);
    expect((await bob.request(`/api/docs/${doc.id}/versions/${version.id}/snapshot`)).status).toBe(200);
    expect((await bob.request(`/api/docs/${doc.id}/versions`, json('POST', { name: 'x' }))).status).toBe(403);
    expect((await bob.request(`/api/docs/${doc.id}/versions/${version.id}`, json('PATCH', { name: 'x' }))).status).toBe(403);
    expect((await bob.request(`/api/docs/${doc.id}/versions/${version.id}/restore`, { method: 'POST' })).status).toBe(403);
    expect(rooms.restores).toEqual([]);

    // Without docs:update even the owner cannot; a document they cannot see is a 404.
    const reader = app({ keys: ['docs:read'] });
    expect((await reader.request(`/api/docs/${doc.id}/versions/${version.id}/restore`, { method: 'POST' })).status).toBe(403);
    await db.update(files).set({ generalAccess: 'restricted' }).where(eq(files.id, doc.fileId));
    expect((await bob.request(`/api/docs/${doc.id}/versions`)).status).toBe(404);
  });
});
