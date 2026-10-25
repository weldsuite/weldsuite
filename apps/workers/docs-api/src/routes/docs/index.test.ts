import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { docs, files, folders, workspaceMembers } from '@weldsuite/db/schema';
import { WELDDOC_MIME_TYPE, type DocSession, type DocSummary } from '@weldsuite/app-api-client/schemas/docs';
import { DocModel, applyOp } from '@weldsuite/docs-engine';
import type { Env, Variables } from '../../types';
import { readSnapshot } from '../../room/snapshot';
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

async function create(body: Record<string, unknown>, userId = ALICE): Promise<DocSummary> {
  const res = await app({ userId }).request('/api/docs', json('POST', body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: DocSummary }).data;
}

const storedKey = (doc: DocSummary) => `workspaces/org_test_default/docs/${doc.id}/document.json.gz`;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(docs);
  await db.delete(files);
  await db.delete(folders);
  await db.delete(workspaceMembers);
  bucket = new FakeBucket();
  rooms = fakeRoomNamespace();
});

describe('/api/docs', () => {
  it('creates a document as a drive file with a first checkpoint', async () => {
    const doc = await create({ name: 'Plan 2027' });
    expect(doc).toMatchObject({ name: 'Plan 2027', role: 'owner', canEdit: true, folderId: null, createdById: ALICE, revision: 0 });
    expect(doc.id).toMatch(/^doc_/);

    const [file] = await db.select().from(files).where(eq(files.id, doc.fileId));
    expect(file).toMatchObject({ mimeType: WELDDOC_MIME_TYPE, fileType: 'document', uploadedById: ALICE, bucket: 'private' });
    expect(file!.metadata).toEqual({ weldDocId: doc.id });
    expect(file!.fileKey).toBe(storedKey(doc));

    // A WeldDocs row has no BlockNote content: the room and R2 hold it.
    const [row] = await db.select().from(docs).where(eq(docs.id, doc.id));
    expect(row).toMatchObject({ content: null, snapshotKey: storedKey(doc), revision: 0, snapshotRevision: 0 });

    const stored = await readSnapshot(bucket.asBinding(), storedKey(doc));
    expect(stored?.revision).toBe(0);
    expect(stored?.doc).toEqual(DocModel.create().toSnapshot());
  });

  it('names a document when none is given', async () => {
    expect((await create({})).name).toBe('Untitled document');
  });

  it('starts from a snapshot it can load, and refuses one it cannot', async () => {
    const start = DocModel.create();
    applyOp(start, { type: 'insert', story: 'body', at: 0, content: { text: 'Imported text' } });
    const doc = await create({ name: 'Imported', snapshot: start.toSnapshot() });
    expect((await readSnapshot(bucket.asBinding(), storedKey(doc)))!.doc.stories['body']!.text).toContain('Imported text');

    const refused = async (snapshot: unknown) => {
      const res = await app().request('/api/docs', json('POST', { name: 'Bad', snapshot }));
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
    };
    expect(await refused({ version: 99, props: {}, styles: {}, lists: {}, stories: {}, tables: {}, anchors: [] })).toBe('invalid_snapshot');
    expect(await refused({ version: 1 })).toBe('invalid_snapshot');
    // What the room would refuse as ops is refused here too: a script link, a table without rows.
    const scripted = DocModel.create().toSnapshot();
    scripted.stories['body'] = { text: 'click\n', runs: [[5, { link: 'javascript:alert(1)' }]] };
    expect(await refused(scripted)).toBe('invalid_snapshot');
    const rowless = DocModel.create().toSnapshot();
    rowless.tables['t1'] = { rows: [], cols: [{ id: 'c1', width: 100 }] };
    expect(await refused(rowless)).toBe('invalid_snapshot');
    expect(await refused('nope')).toBeUndefined();
    expect(await db.select().from(docs)).toHaveLength(1);
  });

  it('refuses a snapshot past the size limit', async () => {
    const big = DocModel.create().toSnapshot();
    big.stories['body'] = { text: 'x'.repeat(11 * 1024 * 1024) };
    const res = await app().request('/api/docs', json('POST', { name: 'Huge', snapshot: big }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe('too_large');
  });

  it('lists, searches, reads and renames documents', async () => {
    const a = await create({ name: 'Budget' });
    await create({ name: 'Planning' });
    const list = (await (await app().request('/api/docs')).json()) as { data: DocSummary[]; pagination: { totalCount: number } };
    expect(list.data.map((s) => s.name).sort()).toEqual(['Budget', 'Planning']);
    expect(list.pagination.totalCount).toBe(2);
    const found = (await (await app().request('/api/docs?search=plan')).json()) as { data: DocSummary[] };
    expect(found.data.map((s) => s.name)).toEqual(['Planning']);

    const res = await app().request(`/api/docs/${a.id}`, json('PATCH', { name: 'Budget 2028' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: DocSummary }).data.name).toBe('Budget 2028');
    expect((await app().request(`/api/docs/${a.id}`, json('PATCH', { name: 'Planning' }))).status).toBe(409);
    expect((await app().request(`/api/docs/${a.id}`, json('PATCH', {}))).status).toBe(400);
    expect((await app().request('/api/docs/doc_nope')).status).toBe(404);
  });

  it('pages through the list', async () => {
    for (const name of ['One', 'Two', 'Three']) await create({ name });
    const first = (await (await app().request('/api/docs?limit=2')).json()) as { data: DocSummary[]; pagination: { hasMore: boolean; cursor: string } };
    expect(first.data).toHaveLength(2);
    expect(first.pagination).toMatchObject({ hasMore: true, cursor: '2' });
    const rest = (await (await app().request('/api/docs?limit=2&cursor=2')).json()) as { data: DocSummary[]; pagination: { hasMore: boolean } };
    expect(rest.data).toHaveLength(1);
    expect(rest.pagination.hasMore).toBe(false);
  });

  it('moves a document into a folder the caller may add to, and back to My Drive', async () => {
    await db.insert(folders).values([
      { id: 'fld_mine', name: 'Mine', createdById: ALICE },
      { id: 'fld_closed', name: 'Closed', createdById: BOB, generalAccess: 'workspace_view' },
    ]);
    const doc = await create({ name: 'Movable' });
    const moved = await app().request(`/api/docs/${doc.id}`, json('PATCH', { folderId: 'fld_mine' }));
    expect(((await moved.json()) as { data: DocSummary }).data.folderId).toBe('fld_mine');
    expect((await app().request(`/api/docs/${doc.id}`, json('PATCH', { folderId: 'fld_closed' }))).status).toBe(403);
    expect((await app().request(`/api/docs/${doc.id}`, json('PATCH', { folderId: 'fld_missing' }))).status).toBe(404);
    const home = await app().request(`/api/docs/${doc.id}`, json('PATCH', { folderId: null }));
    expect(((await home.json()) as { data: DocSummary }).data.folderId).toBeNull();
  });

  it('leaves documents from before WeldDocs out', async () => {
    await db.insert(files).values({ id: 'fil_old', fileName: 'Old.docx', mimeType: 'x', fileSize: 1, fileType: 'document', storagePath: 'k', uploadedById: ALICE });
    await db.insert(docs).values({ id: 'doc_old', fileId: 'fil_old', content: [{ type: 'paragraph' }] });
    const list = (await (await app().request('/api/docs')).json()) as { data: DocSummary[] };
    expect(list.data).toEqual([]);
    expect((await app().request('/api/docs/doc_old')).status).toBe(404);
    expect((await app().request('/api/docs/doc_old/session', { method: 'POST' })).status).toBe(404);
  });

  it('follows drive sharing: hidden documents are 404, view-only ones cannot change', async () => {
    const hidden = await create({ name: 'Private' });
    await db.update(files).set({ generalAccess: 'restricted' }).where(eq(files.id, hidden.fileId));
    const shown = await create({ name: 'Read me' });
    await db.update(files).set({ generalAccess: 'workspace_view' }).where(eq(files.id, shown.fileId));

    const bob = app({ userId: BOB });
    expect((await bob.request(`/api/docs/${hidden.id}`)).status).toBe(404);
    expect((await bob.request(`/api/docs/${hidden.id}/snapshot`)).status).toBe(404);
    const list = (await (await bob.request('/api/docs')).json()) as { data: DocSummary[] };
    expect(list.data.map((s) => s.name)).toEqual(['Read me']);
    expect(list.data[0]).toMatchObject({ role: 'viewer', canEdit: false });
    expect((await bob.request(`/api/docs/${shown.id}`, json('PATCH', { name: 'Mine now' }))).status).toBe(403);
    expect((await bob.request(`/api/docs/${shown.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('only creates in folders the caller may add to', async () => {
    await db.insert(folders).values({ id: 'fld_closed', name: 'Closed', createdById: BOB, generalAccess: 'workspace_view' });
    const res = await app().request('/api/docs', json('POST', { name: 'Nope', folderId: 'fld_closed' }));
    expect(res.status).toBe(403);
    expect((await app().request('/api/docs', json('POST', { name: 'Nope', folderId: 'fld_missing' }))).status).toBe(404);
  });

  it('moves a document to the trash', async () => {
    const doc = await create({ name: 'Old' });
    expect((await app().request(`/api/docs/${doc.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app().request(`/api/docs/${doc.id}`)).status).toBe(404);
    const [file] = await db.select().from(files).where(eq(files.id, doc.fileId));
    expect(file!.deletedAt).not.toBeNull();
  });

  it('opens a session in the document room with the member profile', async () => {
    await db.insert(workspaceMembers).values({ id: 'wm_alice', userId: ALICE, name: 'Alice Jansen', picture: 'https://img/alice.png' });
    const doc = await create({ name: 'Shared' });
    const res = await app().request(`/api/docs/${doc.id}/session`, { method: 'POST' });
    expect(res.status).toBe(200);
    const session = ((await res.json()) as { data: DocSession }).data;
    expect(session.canEdit).toBe(true);
    expect(session.ticket).toBe(`${'f'.repeat(64)}.ticket-for-${ALICE}`);
    expect(rooms.admissions).toEqual([
      {
        name: `org_test_default:${doc.id}`,
        admission: expect.objectContaining({
          docId: doc.id,
          workspaceId: 'org_test_default',
          snapshotKey: storedKey(doc),
          userId: ALICE,
          name: 'Alice Jansen',
          picture: 'https://img/alice.png',
          color: session.color,
          canEdit: true,
        }),
      },
    ]);
  });

  it('opens read-only sessions without docs:update, and for viewers', async () => {
    const doc = await create({ name: 'Look only' });
    const res = await app({ keys: ['docs:read'] }).request(`/api/docs/${doc.id}/session`, { method: 'POST' });
    expect(((await res.json()) as { data: DocSession }).data.canEdit).toBe(false);
    expect(rooms.admissions[0]!.admission.canEdit).toBe(false);

    await db.update(files).set({ generalAccess: 'workspace_view' }).where(eq(files.id, doc.fileId));
    const viewer = await app({ userId: BOB }).request(`/api/docs/${doc.id}/session`, { method: 'POST' });
    expect(((await viewer.json()) as { data: DocSession }).data.canEdit).toBe(false);
  });

  it('serves the room\'s live snapshot to readers, edits not checkpointed yet included', async () => {
    const doc = await create({ name: 'Print me' });
    rooms.live.liveJson = JSON.stringify({ version: 1, stories: { body: { text: 'Live' } } });
    const res = await app({ keys: ['docs:read'] }).request(`/api/docs/${doc.id}/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ data: { revision: 7, snapshot: { version: 1, stories: { body: { text: 'Live' } } } } });
    expect(rooms.snapshots[0]).toMatchObject({ name: `org_test_default:${doc.id}`, doc: { docId: doc.id, snapshotKey: storedKey(doc) } });
  });
});
