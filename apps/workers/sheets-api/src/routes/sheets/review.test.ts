/**
 * Phases 7–8 routes through real rooms: sessions per mode, versions,
 * connected tables against a real CRM table, WeldFlow project sheets (create,
 * list, copy, convert in place) and the agent tool routes.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import * as schema from '@weldsuite/db/schema';
import type { SheetDataRefreshResult, SheetDataSource, SheetSession, SheetSummary, SheetVersion } from '@weldsuite/app-api-client/schemas/sheets';
import { Engine, Sheet, Workbook, writeXlsx } from '@weldsuite/sheets-engine';
import type { Env, Variables } from '../../types';
import { FakeBucket, liveRoomNamespace } from '../../test-support/fakes';
import { META_SHEET, type LegacyModel } from '../../services/legacy-project-sheet';
import sheetRoutes from './index';
import agentRoutes from '../internal/agent';

let db: Database;
/** Flips what the agent routes' middleware sees as the workspace's read-only state. */
let agentReadOnly = false;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
  // The agent's path param is the Clerk org id; the lookup hands back both ids, like the real one.
  getWorkspaceContextForOrg: async (_env: unknown, ref: string) => ({
    id: 'ws_test_default',
    clerkOrgId: ref,
    db,
    suspended: false,
    licensedApps: null,
    readOnly: agentReadOnly,
    readOnlyReason: agentReadOnly ? ('licence_inactive' as const) : null,
  }),
}));
vi.mock('@weldsuite/notifications', () => ({ createAndDeliverNotification: async () => undefined }));

const WORKSPACE = 'org_test_default';
const ALL = ['sheets:read', 'sheets:create', 'sheets:update', 'sheets:delete', 'companies:read', 'projects:read'];
const ALICE = 'user_alice';
const BOB = 'user_bob';

let bucket: FakeBucket;
let publicBucket: FakeBucket;
let rooms: ReturnType<typeof liveRoomNamespace>;

const env = () => ({ PRIVATE_STORAGE: bucket.asBinding(), STORAGE: publicBucket.asBinding(), SHEET_ROOM: rooms.binding }) as unknown as Env;

function app(options: { userId?: string; keys?: string[] } = {}) {
  return createTestApp<Env, Variables>('/api/sheets', sheetRoutes, {
    context: { tenantDb: db, permissions: permissions(...(options.keys ?? ALL)), userId: options.userId ?? ALICE },
    env: env(),
  });
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function call<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = (await r.json()) as { data: T };
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

const create = (body: Record<string, unknown>, opts: { userId?: string; keys?: string[] } = {}) =>
  call<SheetSummary>(app(opts).request('/api/sheets', json('POST', body)), 201);

async function member(userId: string, role = 'MEMBER', extra: Record<string, unknown> = {}) {
  await db.insert(schema.workspaceMembers).values({ id: `wm_${userId}`, userId, name: userId, role, ...extra } as typeof schema.workspaceMembers.$inferInsert);
}

const metaFor = (sheetId: string) => ({ workspaceId: WORKSPACE, sheetId, snapshotKey: `workspaces/${WORKSPACE}/sheets/${sheetId}/workbook.json.gz` });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.sheetDataSources);
  await db.delete(schema.sheetVersions);
  await db.delete(schema.sheets);
  await db.delete(schema.files);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.companies);
  await db.delete(schema.projectMembers);
  await db.delete(schema.projects);
  bucket = new FakeBucket();
  publicBucket = new FakeBucket();
  rooms = liveRoomNamespace(env);
  agentReadOnly = false;
});

describe('sessions', () => {
  it('opens a sheet to edit, to comment (viewers with sheets:comment) or only to view', async () => {
    const sheet = await create({ name: 'Plan' });
    await db.update(schema.files).set({ generalAccess: 'workspace_view' }).where(eq(schema.files.id, sheet.fileId));
    const session = (userId: string, keys: string[]) => call<SheetSession>(app({ userId, keys }).request(`/api/sheets/${sheet.id}/session`, { method: 'POST' }));
    expect(await session(ALICE, ALL)).toMatchObject({ mode: 'edit', canEdit: true });
    expect(await session(BOB, [...ALL, 'sheets:comment'])).toMatchObject({ mode: 'comment', canEdit: false });
    expect(await session(BOB, ALL)).toMatchObject({ mode: 'view', canEdit: false });
  });
});

describe('versions', () => {
  it('names, renames, lists, downloads and restores versions', async () => {
    const sheet = await create({ name: 'Plan' });
    const room = rooms.roomFor(`${WORKSPACE}:${sheet.id}`).room;
    const tabId = (await room.tabs(metaFor(sheet.id)))[0]!.id;
    await room.writeRange(metaFor(sheet.id), { tab: tabId, values: [[1]], userId: ALICE });

    const named = await call<SheetVersion>(app().request(`/api/sheets/${sheet.id}/versions`, json('POST', { name: 'Draft' })), 201);
    expect(named).toMatchObject({ name: 'Draft', revision: 1, sheetId: sheet.id, createdById: ALICE });
    const renamed = await call<SheetVersion>(app().request(`/api/sheets/${sheet.id}/versions/${named.id}`, json('PATCH', { name: 'First draft' })));
    expect(renamed.name).toBe('First draft');

    const snap = await call<{ revision: number; snapshot: { sheets: unknown[] } }>(app().request(`/api/sheets/${sheet.id}/versions/${named.id}/snapshot`));
    expect(snap.revision).toBe(1);
    const xlsx = await app().request(`/api/sheets/${sheet.id}/versions/${named.id}/export`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('Content-Disposition')).toContain('Plan (First draft).xlsx');

    await room.writeRange(metaFor(sheet.id), { tab: tabId, values: [[2]], userId: ALICE });
    const restored = await call<{ revision: number; autoVersion: SheetVersion }>(app().request(`/api/sheets/${sheet.id}/versions/${named.id}/restore`, json('POST')));
    expect(restored).toMatchObject({ revision: 3, autoVersion: { name: null, revision: 2 } });
    expect(await room.readRange(metaFor(sheet.id), { range: 'A1' })).toMatchObject({ values: [[1]] });

    const list = await call<SheetVersion[]>(app().request(`/api/sheets/${sheet.id}/versions`));
    expect(list.map((v) => v.name)).toEqual([null, 'First draft']);
    // Viewers see the history but cannot change it.
    await db.update(schema.files).set({ generalAccess: 'workspace_view' }).where(eq(schema.files.id, sheet.fileId));
    expect((await app({ userId: BOB }).request(`/api/sheets/${sheet.id}/versions`)).status).toBe(200);
    expect((await app({ userId: BOB }).request(`/api/sheets/${sheet.id}/versions`, json('POST', { name: 'x' }))).status).toBe(403);
    expect((await app().request(`/api/sheets/${sheet.id}/versions/shtv_nope/restore`, json('POST'))).status).toBe(404);
  });
});

describe('connected tables', () => {
  const definition = { columns: ['name', 'leadScore'], headers: ['Company', 'Staff'], filters: [], sort: { field: 'name' }, limit: 100 };

  it('lists records into the sheet, refreshes them, and disconnects leaving the values', async () => {
    await member(ALICE, 'OWNER');
    await db.insert(schema.companies).values([
      { id: 'co_1', name: 'Bolt', displayName: 'Bolt', leadScore: 20 },
      { id: 'co_2', name: 'Acme', displayName: 'Acme', leadScore: 10 },
    ] as (typeof schema.companies.$inferInsert)[]);
    const sheet = await create({ name: 'CRM' });
    const meta = metaFor(sheet.id);
    const room = rooms.roomFor(`${WORKSPACE}:${sheet.id}`).room;
    const tabId = (await room.tabs(meta))[0]!.id;

    const created = await call<SheetDataRefreshResult>(
      app().request(`/api/sheets/${sheet.id}/data-sources`, json('POST', { objectType: 'companies', definition, refresh: 'daily', target: { tabId, row: 1, col: 1 } })),
      201,
    );
    expect(created).toMatchObject({ refreshed: true, source: { rowCount: 2, lastError: null, refresh: 'daily', createdById: ALICE } });
    expect(created.source.nextRefreshAt).not.toBeNull();
    expect(await room.readRange(meta, { range: 'B2:C4' })).toMatchObject({ values: [['Company', 'Staff'], ['Acme', 10], ['Bolt', 20]] });
    expect(rooms.roomFor(`${WORKSPACE}:${sheet.id}`).state.storage.data.get('refreshAt')).toBe(Date.parse(created.source.nextRefreshAt!));

    await db.insert(schema.companies).values({ id: 'co_3', name: 'Coda', displayName: 'Coda', leadScore: 5 } as typeof schema.companies.$inferInsert);
    const refreshed = await call<SheetDataRefreshResult>(app().request(`/api/sheets/${sheet.id}/data-sources/${created.source.id}/refresh`, json('POST')));
    expect(refreshed.source.rowCount).toBe(3);
    expect(await room.readRange(meta, { range: 'B5' })).toMatchObject({ values: [['Coda']] });

    const changed = await call<SheetDataRefreshResult>(
      app().request(`/api/sheets/${sheet.id}/data-sources/${created.source.id}`, json('PATCH', { definition: { ...definition, limit: 1 }, refresh: 'manual' })),
    );
    expect(changed.source).toMatchObject({ rowCount: 1, refresh: 'manual', nextRefreshAt: null });
    expect(await room.readRange(meta, { range: 'B3:B5' })).toMatchObject({ values: [['Acme'], [null], [null]] });

    const list = await call<SheetDataSource[]>(app().request(`/api/sheets/${sheet.id}/data-sources`));
    expect(list).toHaveLength(1);
    expect((await app().request(`/api/sheets/${sheet.id}/data-sources/${created.source.id}`, json('DELETE'))).status).toBe(204);
    expect(await room.readRange(meta, { range: 'B3' })).toMatchObject({ values: [['Acme']] });
    expect(await call<SheetDataSource[]>(app().request(`/api/sheets/${sheet.id}/data-sources`))).toEqual([]);
  });

  it('needs the object’s own read permission to connect or change one', async () => {
    const sheet = await create({ name: 'CRM' });
    const keys = ALL.filter((k) => k !== 'companies:read');
    const res = await app({ keys }).request(`/api/sheets/${sheet.id}/data-sources`, json('POST', { objectType: 'companies', definition, target: { tabId: 'x', row: 0, col: 0 } }));
    expect(res.status).toBe(403);
    const bad = await app().request(`/api/sheets/${sheet.id}/data-sources`, json('POST', { objectType: 'companies', definition: { ...definition, columns: ['nope'], headers: ['Nope'] }, target: { tabId: 'x', row: 0, col: 0 } }));
    expect(bad.status).toBe(400);
  });

  it('records a refresh that cannot happen', async () => {
    // An employee member holds only My HR's permissions, whatever this request says.
    await member(ALICE, 'MEMBER', { memberType: 'EMPLOYEE' });
    const sheet = await create({ name: 'CRM' });
    const tabId = (await rooms.roomFor(`${WORKSPACE}:${sheet.id}`).room.tabs(metaFor(sheet.id)))[0]!.id;
    // Alice holds companies:read in this request, but her role in the workspace does not.
    const created = await call<SheetDataRefreshResult>(
      app().request(`/api/sheets/${sheet.id}/data-sources`, json('POST', { objectType: 'companies', definition, target: { tabId, row: 0, col: 0 } })),
      201,
    );
    expect(created).toMatchObject({ refreshed: false, source: { lastError: 'no_permission', rowCount: 0 } });
  });
});

describe('WeldFlow project sheets', () => {
  async function project(id: string, members: { userId: string; role: string }[]) {
    const now = new Date();
    await db.insert(schema.projects).values({ id, name: id, createdAt: now, updatedAt: now } as typeof schema.projects.$inferInsert);
    if (members.length) {
      await db.insert(schema.projectMembers).values(
        members.map((m, i) => ({ id: `pm_${id}_${i}`, projectId: id, userId: m.userId, role: m.role, isActive: true })) as (typeof schema.projectMembers.$inferInsert)[],
      );
    }
  }

  it('creates, lists and copies a project’s sheets, following project membership', async () => {
    await project('proj_a', [
      { userId: ALICE, role: 'member' },
      { userId: BOB, role: 'viewer' },
    ]);
    const sheet = await create({ name: 'Budget', projectId: 'proj_a' });
    const [file] = await db.select().from(schema.files).where(eq(schema.files.id, sheet.fileId));
    expect(file).toMatchObject({ entityType: 'project', entityId: 'proj_a', folderId: null });

    const forProject = await call<SheetSummary[]>(app().request('/api/sheets?projectId=proj_a'));
    expect(forProject.map((s) => s.name)).toEqual(['Budget']);
    expect(await call<SheetSummary[]>(app().request('/api/sheets'))).toEqual([]);
    expect((await call<SheetSummary[]>(app({ userId: BOB }).request('/api/sheets?projectId=proj_a')))[0]).toMatchObject({ role: 'viewer', canEdit: false });
    expect((await app({ userId: 'user_stranger' }).request('/api/sheets?projectId=proj_a')).status).toBe(404);
    expect((await app({ userId: 'user_stranger' }).request(`/api/sheets/${sheet.id}`)).status).toBe(404);
    expect((await app({ userId: BOB }).request('/api/sheets', json('POST', { name: 'Mine', projectId: 'proj_a' }))).status).toBe(403);

    const room = rooms.roomFor(`${WORKSPACE}:${sheet.id}`).room;
    await room.writeRange(metaFor(sheet.id), { values: [['copied']], userId: ALICE });
    const copy = await create({ name: 'Budget (copy)', projectId: 'proj_a', copyFromSheetId: sheet.id });
    const copied = await rooms.roomFor(`${WORKSPACE}:${copy.id}`).room.readRange(metaFor(copy.id), { range: 'A1' });
    expect(copied).toMatchObject({ values: [['copied']] });
  });

  it('converts an old project sheet in place on first open, once', async () => {
    await project('proj_b', [{ userId: ALICE, role: 'member' }]);
    const model: LegacyModel = {
      sheets: [{ id: 's', name: 'Tasks', position: 0 }],
      columnsBySheet: { s: [{ id: 'c', name: 'Task', position: 0 }] },
      rowsBySheet: { s: [{ id: 'r', position: 0, data: { c: 'Write docs' } }] },
    };
    const wb = new Workbook();
    wb.sheets.push(new Sheet('t1', 'Tasks'), new Sheet('t2', META_SHEET));
    const engine = new Engine(wb);
    engine.setContent('t2', 0, 0, { v: JSON.stringify({ v: 1, model }) });
    const key = `workspaces/${WORKSPACE}/sheets/proj_b/1_Tasks.xlsx`;
    await publicBucket.put(key, await writeXlsx(engine));
    await db.insert(schema.files).values({
      id: 'fil_old',
      fileName: 'Tasks.xlsx',
      originalName: 'Tasks.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileSize: 100,
      fileType: 'spreadsheet',
      storagePath: key,
      fileKey: key,
      uploadedById: ALICE,
      entityType: 'project',
      entityId: 'proj_b',
    } as typeof schema.files.$inferInsert);

    const converted = await call<SheetSummary>(app().request('/api/sheets/convert', json('POST', { fileId: 'fil_old' })), 201);
    expect(converted).toMatchObject({ fileId: 'fil_old', name: 'Tasks' });
    const [file] = await db.select().from(schema.files).where(eq(schema.files.id, 'fil_old'));
    expect(file).toMatchObject({ entityType: 'project', entityId: 'proj_b', bucket: 'private', mimeType: 'application/vnd.weldsuite.spreadsheet' });
    expect(file!.metadata).toMatchObject({ weldsheetId: converted.id, convertedFrom: { key } });
    const room = rooms.roomFor(`${WORKSPACE}:${converted.id}`).room;
    expect(await room.readRange({ workspaceId: WORKSPACE, sheetId: converted.id, snapshotKey: file!.fileKey! }, { range: 'A1:A2' })).toMatchObject({ values: [['Task'], ['Write docs']] });

    // Opened again (or by someone else): the same sheet, not a second one.
    const again = await call<SheetSummary>(app().request('/api/sheets/convert', json('POST', { fileId: 'fil_old' })));
    expect(again.id).toBe(converted.id);
    expect(await db.select().from(schema.sheets)).toHaveLength(1);
    expect((await app({ userId: 'user_stranger' }).request('/api/sheets/convert', json('POST', { fileId: 'fil_old' }))).status).toBe(404);
  });
});

describe('agent tool routes', () => {
  function agent(userId = ALICE) {
    const internal = new Hono<{ Bindings: Env; Variables: Variables }>();
    internal.route('/internal/agent', agentRoutes);
    return {
      request: (path: string, body: unknown = {}) =>
        internal.request(`/internal/agent/${WORKSPACE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-weld-user': userId }, body: JSON.stringify(body) }, env()),
    };
  }

  it('finds, creates, reads and writes sheets as the person the agent works for', async () => {
    await member(ALICE, 'OWNER');
    await member(BOB, 'VIEWER');
    const made = await call<{ id: string; name: string }>(agent().request('/sheets/create', { name: 'Agent sheet', values: [['Item', 'Qty'], ['Pens', 4]] }), 201);
    const found = await call<{ id: string; name: string }[]>(agent().request('/sheets/find', { query: 'agent' }));
    expect(found.map((s) => s.name)).toEqual(['Agent sheet']);
    expect(await call(agent().request(`/sheets/${made.id}/read`, {}))).toMatchObject({ values: [['Item', 'Qty'], ['Pens', 4]], tabName: 'Sheet1' });
    expect(await call(agent().request(`/sheets/${made.id}/write`, { range: 'B3', values: [[6], ['=SUM(B2:B3)']] }))).toMatchObject({ ok: true });
    expect(await call(agent().request(`/sheets/${made.id}/read`, { range: 'B4' }))).toMatchObject({ values: [[10]] });
    expect(await call(agent().request(`/sheets/${made.id}/tabs`))).toMatchObject({ name: 'Agent sheet', tabs: [{ name: 'Sheet1' }] });

    await db.update(schema.files).set({ generalAccess: 'workspace_view' });
    expect((await agent(BOB).request(`/sheets/${made.id}/write`, { values: [[1]] })).status).toBe(403);
    await db.update(schema.files).set({ generalAccess: 'restricted' });
    expect((await agent(BOB).request(`/sheets/${made.id}/read`)).status).toBe(404);
    expect((await agent().request('/sheets/find', {})).status).toBe(200);
  });

  it('checks the same sheets:read / sheets:create permissions the public routes do', async () => {
    await member(ALICE, 'OWNER');
    const made = await call<{ id: string; name: string }>(agent().request('/sheets/create', { name: 'Gate check' }), 201);
    // An employee member holds only My HR's and WeldChat's permissions, sheets not among them.
    await member(BOB, 'MEMBER', { memberType: 'EMPLOYEE' });
    expect((await agent(BOB).request('/sheets/find', { query: 'gate' })).status).toBe(403);
    expect((await agent(BOB).request(`/sheets/${made.id}/tabs`)).status).toBe(403);
    expect((await agent(BOB).request(`/sheets/${made.id}/read`, {})).status).toBe(403);
    expect((await agent(BOB).request('/sheets/create', { name: 'Not allowed' })).status).toBe(403);
  });

  it('refuses to create or write in a read-only workspace, but still lets it read', async () => {
    await member(ALICE, 'OWNER');
    const made = await call<{ id: string; name: string }>(agent().request('/sheets/create', { name: 'Before the lapse' }), 201);
    agentReadOnly = true;
    expect((await agent().request('/sheets/create', { name: 'After the lapse' })).status).toBe(403);
    expect((await agent().request(`/sheets/${made.id}/write`, { values: [[1]] })).status).toBe(403);
    expect((await agent().request(`/sheets/${made.id}/read`, {})).status).toBe(200);
  });
});
