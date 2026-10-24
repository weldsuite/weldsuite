import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { files, folders, sheets, workspaceMembers } from '@weldsuite/db/schema';
import { WELDSHEET_MIME_TYPE, type SheetSession, type SheetSummary } from '@weldsuite/app-api-client/schemas/sheets';
import type { Env, Variables } from '../../types';
import { readSnapshot } from '../../room/snapshot';
import { FakeBucket, fakeRoomNamespace } from '../../test-support/fakes';
import sheetRoutes from './index';

const ALL = ['sheets:read', 'sheets:create', 'sheets:update', 'sheets:delete'];
const ALICE = 'user_alice';
const BOB = 'user_bob';

let db: Database;
let bucket: FakeBucket;
let rooms: ReturnType<typeof fakeRoomNamespace>;

function app(options: { userId?: string; keys?: string[] } = {}) {
  return createTestApp<Env, Variables>('/api/sheets', sheetRoutes, {
    context: { tenantDb: db, permissions: permissions(...(options.keys ?? ALL)), userId: options.userId ?? ALICE },
    env: { PRIVATE_STORAGE: bucket.asBinding(), SHEET_ROOM: rooms.binding },
  });
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function create(body: Record<string, unknown>, userId = ALICE): Promise<SheetSummary> {
  const res = await app({ userId }).request('/api/sheets', json('POST', body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: SheetSummary }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(sheets);
  await db.delete(files);
  await db.delete(folders);
  await db.delete(workspaceMembers);
  bucket = new FakeBucket();
  rooms = fakeRoomNamespace();
});

describe('/api/sheets', () => {
  it('creates a sheet as a drive file with a first checkpoint', async () => {
    const sheet = await create({ name: 'Budget 2027', firstTabName: 'Blad1' });
    expect(sheet).toMatchObject({ name: 'Budget 2027', role: 'owner', canEdit: true, folderId: null, createdById: ALICE });
    expect(sheet.id).toMatch(/^sht_/);

    const [file] = await db.select().from(files).where(eq(files.id, sheet.fileId));
    expect(file).toMatchObject({ mimeType: WELDSHEET_MIME_TYPE, fileType: 'spreadsheet', uploadedById: ALICE, bucket: 'private' });
    expect(file!.metadata).toEqual({ weldsheetId: sheet.id });

    const key = `workspaces/org_test_default/sheets/${sheet.id}/workbook.json.gz`;
    const stored = await readSnapshot(bucket.asBinding(), key);
    expect(stored?.revision).toBe(0);
    expect(stored?.workbook.sheets.map((s) => s.name)).toEqual(['Blad1']);
    expect(file!.fileKey).toBe(key);
  });

  it('lists, searches, reads and renames sheets', async () => {
    const a = await create({ name: 'Budget' });
    await create({ name: 'Planning' });
    const list = (await (await app().request('/api/sheets')).json()) as { data: SheetSummary[]; pagination: { totalCount: number } };
    expect(list.data.map((s) => s.name).sort()).toEqual(['Budget', 'Planning']);
    expect(list.pagination.totalCount).toBe(2);
    const found = (await (await app().request('/api/sheets?search=plan')).json()) as { data: SheetSummary[] };
    expect(found.data.map((s) => s.name)).toEqual(['Planning']);

    const res = await app().request(`/api/sheets/${a.id}`, json('PATCH', { name: 'Budget 2028' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: SheetSummary }).data.name).toBe('Budget 2028');
    expect((await app().request(`/api/sheets/${a.id}`, json('PATCH', { name: 'Planning' }))).status).toBe(409);
    expect((await app().request('/api/sheets/sht_nope')).status).toBe(404);
  });

  it('pages through the list', async () => {
    for (const name of ['One', 'Two', 'Three']) await create({ name });
    const first = (await (await app().request('/api/sheets?limit=2')).json()) as { data: SheetSummary[]; pagination: { hasMore: boolean; cursor: string } };
    expect(first.data).toHaveLength(2);
    expect(first.pagination).toMatchObject({ hasMore: true, cursor: '2' });
    const rest = (await (await app().request('/api/sheets?limit=2&cursor=2')).json()) as { data: SheetSummary[]; pagination: { hasMore: boolean } };
    expect(rest.data).toHaveLength(1);
    expect(rest.pagination.hasMore).toBe(false);
  });

  it('follows drive sharing: hidden sheets are 404, view-only ones cannot change', async () => {
    const hidden = await create({ name: 'Private' });
    await db.update(files).set({ generalAccess: 'restricted' }).where(eq(files.id, hidden.fileId));
    const shown = await create({ name: 'Read me' });
    await db.update(files).set({ generalAccess: 'workspace_view' }).where(eq(files.id, shown.fileId));

    const bob = app({ userId: BOB });
    expect((await bob.request(`/api/sheets/${hidden.id}`)).status).toBe(404);
    const list = (await (await bob.request('/api/sheets')).json()) as { data: SheetSummary[] };
    expect(list.data.map((s) => s.name)).toEqual(['Read me']);
    expect(list.data[0]).toMatchObject({ role: 'viewer', canEdit: false });
    expect((await bob.request(`/api/sheets/${shown.id}`, json('PATCH', { name: 'Mine now' }))).status).toBe(403);
    expect((await bob.request(`/api/sheets/${shown.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('only creates in folders the caller may add to', async () => {
    await db.insert(folders).values({ id: 'fld_closed', name: 'Closed', createdById: BOB, generalAccess: 'workspace_view' });
    const res = await app().request('/api/sheets', json('POST', { name: 'Nope', folderId: 'fld_closed' }));
    expect(res.status).toBe(403);
    expect((await app().request('/api/sheets', json('POST', { name: 'Nope', folderId: 'fld_missing' }))).status).toBe(404);
  });

  it('moves a sheet to the trash', async () => {
    const sheet = await create({ name: 'Old' });
    expect((await app().request(`/api/sheets/${sheet.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app().request(`/api/sheets/${sheet.id}`)).status).toBe(404);
    const [file] = await db.select().from(files).where(eq(files.id, sheet.fileId));
    expect(file!.deletedAt).not.toBeNull();
  });

  it('opens a session in the sheet room with the member profile', async () => {
    await db.insert(workspaceMembers).values({ id: 'wm_alice', userId: ALICE, name: 'Alice Jansen', picture: 'https://img/alice.png' });
    const sheet = await create({ name: 'Shared' });
    const res = await app().request(`/api/sheets/${sheet.id}/session`, { method: 'POST' });
    expect(res.status).toBe(200);
    const session = ((await res.json()) as { data: SheetSession }).data;
    expect(session.canEdit).toBe(true);
    expect(session.ticket).toBe(`${'f'.repeat(64)}.ticket-for-${ALICE}`);
    expect(rooms.admissions).toEqual([
      {
        name: `org_test_default:${sheet.id}`,
        admission: expect.objectContaining({
          sheetId: sheet.id,
          workspaceId: 'org_test_default',
          userId: ALICE,
          name: 'Alice Jansen',
          picture: 'https://img/alice.png',
          color: session.color,
          canEdit: true,
        }),
      },
    ]);
  });

  it('opens read-only sessions without sheets:update', async () => {
    const sheet = await create({ name: 'Look only' });
    const res = await app({ keys: ['sheets:read'] }).request(`/api/sheets/${sheet.id}/session`, { method: 'POST' });
    expect(((await res.json()) as { data: SheetSession }).data.canEdit).toBe(false);
    expect(rooms.admissions[0]!.admission.canEdit).toBe(false);
  });
});
