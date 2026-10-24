import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { files, folders, sheets, workspaceMembers } from '@weldsuite/db/schema';
import { WELDSHEET_MIME_TYPE, type SheetImportResult, type SheetSession, type SheetSummary } from '@weldsuite/app-api-client/schemas/sheets';
import { Engine, writeXlsx } from '@weldsuite/sheets-engine';
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

/** An .xlsx with one tab, Prices, holding a header, two rows and a formula. */
async function xlsxFile(): Promise<Uint8Array> {
  const engine = Engine.fromSnapshot({
    version: 1,
    sheets: [
      {
        id: 'x',
        name: 'Prices',
        rowCount: 1000,
        colCount: 26,
        rows: { defaultSize: 21 },
        cols: { defaultSize: 100 },
        cells: [
          [0, 0, { v: 'Item' }],
          [0, 1, { v: 'Price' }],
          [1, 0, { v: 'Coffee' }],
          [1, 1, { v: 3.5 }],
          [2, 0, { v: 'Total' }],
          [2, 1, { v: null, f: 'SUM(B2:B2)' }],
        ],
      },
    ],
  });
  return writeXlsx(engine);
}

function upload(name: string, bytes: Uint8Array | string, fields: Record<string, string> = {}): RequestInit {
  const form = new FormData();
  form.append('file', new File([bytes], name));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return { method: 'POST', body: form };
}

async function storedWorkbook(sheet: SheetSummary) {
  return (await readSnapshot(bucket.asBinding(), `workspaces/org_test_default/sheets/${sheet.id}/workbook.json.gz`))!.workbook;
}

describe('/api/sheets import and export', () => {
  it('makes a spreadsheet from an uploaded workbook', async () => {
    const res = await app().request('/api/sheets/import', upload('Budget 2027.xlsx', await xlsxFile()));
    expect(res.status).toBe(201);
    const { sheet, warnings } = ((await res.json()) as { data: SheetImportResult }).data;
    expect(sheet).toMatchObject({ name: 'Budget 2027', role: 'owner', folderId: null });
    expect(warnings).toEqual([]);
    const workbook = await storedWorkbook(sheet);
    expect(workbook.sheets.map((s) => s.name)).toEqual(['Prices']);
    expect(workbook.sheets[0]!.id).toMatch(/^sh_/);
    expect(workbook.sheets[0]!.cells.find(([r, c]) => r === 2 && c === 1)?.[2].f).toBe('SUM(B2:B2)');
    const [file] = await db.select().from(files).where(eq(files.id, sheet.fileId));
    expect(file).toMatchObject({ mimeType: WELDSHEET_MIME_TYPE, fileName: 'Budget 2027' });
  });

  it('reads an uploaded CSV in the language asked for, under the name asked for', async () => {
    const res = await app().request('/api/sheets/import', upload('prijzen.csv', 'Item;Prijs\nThee;2,25\n', { locale: 'nl', name: 'Prijzen' }));
    expect(res.status).toBe(201);
    const { sheet } = ((await res.json()) as { data: SheetImportResult }).data;
    expect(sheet.name).toBe('Prijzen');
    const cells = (await storedWorkbook(sheet)).sheets[0]!.cells.map(([, , cell]) => cell.v);
    expect(cells).toEqual(['Item', 'Prijs', 'Thee', 2.25]);
  });

  it('refuses files it cannot read, and says why', async () => {
    const refused = async (init: RequestInit) => {
      const res = await app().request('/api/sheets/import', init);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
    };
    expect(await refused(upload('notes.pdf', '%PDF-1.7'))).toBe('unsupported');
    expect(await refused(upload('broken.xlsx', new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])))).toBe('not_spreadsheet');
    expect(await refused({ method: 'POST', body: new FormData() })).toBeUndefined();
    expect(await db.select().from(files)).toEqual([]);
  });

  it('makes a spreadsheet from a WeldDrive file, next to it when allowed', async () => {
    await db.insert(folders).values([
      { id: 'fld_mine', name: 'Mine', createdById: ALICE },
      { id: 'fld_bob', name: 'Bob', createdById: BOB, generalAccess: 'workspace_view' },
    ]);
    const key = 'workspaces/org_test_default/files/report.xlsx';
    await bucket.put(key, await xlsxFile());
    const drive = (id: string, folderId: string) => ({
      id,
      fileName: 'Report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileSize: 1000,
      storagePath: key,
      fileKey: key,
      folderId,
      uploadedById: ALICE,
      generalAccess: 'workspace_view' as const,
    });
    await db.insert(files).values([drive('fil_mine', 'fld_mine'), drive('fil_bob', 'fld_bob')]);

    const next = await app().request('/api/sheets/import', json('POST', { fileId: 'fil_mine' }));
    expect(next.status).toBe(201);
    expect(((await next.json()) as { data: SheetImportResult }).data.sheet).toMatchObject({ name: 'Report', folderId: 'fld_mine' });
    // Next to a file in a folder Alice may only view: in My Drive instead.
    const fallback = await app().request('/api/sheets/import', json('POST', { fileId: 'fil_bob' }));
    expect(((await fallback.json()) as { data: SheetImportResult }).data.sheet.folderId).toBeNull();
    // Asked for that folder: refused.
    expect((await app().request('/api/sheets/import', json('POST', { fileId: 'fil_bob', folderId: 'fld_bob' }))).status).toBe(403);
  });

  it('keeps imports to files the caller can see in their own workspace', async () => {
    const sheet = await create({ name: 'Already a sheet' });
    const res = await app().request('/api/sheets/import', json('POST', { fileId: sheet.fileId }));
    expect(res.status).toBe(400);
    const other = 'workspaces/org_other/files/theirs.xlsx';
    await bucket.put(other, await xlsxFile());
    await db.insert(files).values({ id: 'fil_other', fileName: 'Theirs.xlsx', mimeType: 'x', fileSize: 1, storagePath: other, fileKey: other, uploadedById: ALICE });
    expect((await app().request('/api/sheets/import', json('POST', { fileId: 'fil_other' }))).status).toBe(404);
    await db.insert(files).values({ id: 'fil_hidden', fileName: 'Hidden.xlsx', mimeType: 'x', fileSize: 1, storagePath: other, uploadedById: BOB, generalAccess: 'restricted' });
    expect((await app().request('/api/sheets/import', json('POST', { fileId: 'fil_hidden' }))).status).toBe(404);
  });

  it('downloads a sheet as written by its room, for viewers too', async () => {
    const sheet = await create({ name: 'Budget' });
    const viewer = app({ keys: ['sheets:read'] });
    const xlsx = await viewer.request(`/api/sheets/${sheet.id}/export`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.headers.get('content-disposition')).toBe(`attachment; filename="Budget.xlsx"; filename*=UTF-8''Budget.xlsx`);
    expect(await xlsx.text()).toBe('xlsx file');
    expect(rooms.exports[0]).toMatchObject({ name: `org_test_default:${sheet.id}`, sheet: { sheetId: sheet.id }, request: { format: 'xlsx' } });

    const csv = await viewer.request(`/api/sheets/${sheet.id}/export?format=csv&tab=Blad%202&locale=nl`);
    expect(csv.headers.get('content-disposition')).toContain(`filename*=UTF-8''Budget%20-%20Blad%202.csv`);
    expect(rooms.exports[1]!.request).toEqual({ format: 'csv', tab: 'Blad 2', locale: 'nl' });
    expect((await viewer.request(`/api/sheets/${sheet.id}/export?format=csv&tab=missing`)).status).toBe(404);
    expect((await viewer.request(`/api/sheets/${sheet.id}/export?format=pdf`)).status).toBe(400);
  });
});
