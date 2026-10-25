/**
 * The room's phase 7–8 work: commenters, mention notifications, versions and
 * restore, server writes (agent tools, connected tables) and scheduled
 * refreshes on the alarm.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { files, sheetDataSources, sheetVersions, sheets } from '@weldsuite/db/schema';
import { Engine, Sheet, Workbook, encode, type ClientMessage, type Op, type ServerMessage, type SheetComment } from '@weldsuite/sheets-engine';
import type { Env } from '../types';
import { FakeBucket, FakeSocket, fakeObjectState } from '../test-support/fakes';
import { createSheet, snapshotKeyFor } from '../services/sheets';
import { versionKeyFor } from '../services/versions';
import { readSnapshot, writeSnapshot } from './snapshot';
import { SheetRoom, type Admission } from './sheet-room';

let db: Database;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
}));
const notified = vi.hoisted(() => [] as { userId: string; title: string; actionUrl: string }[]);
vi.mock('@weldsuite/notifications', () => ({
  createAndDeliverNotification: async (p: { userId: string; title: string; actionUrl: string }) => {
    notified.push({ userId: p.userId, title: p.title, actionUrl: p.actionUrl });
  },
}));
const refreshes = vi.hoisted(() => ({ rows: [['Acme', 10]] as (string | number)[][], error: null as string | null }));
vi.mock('../services/data-sources/refresh', () => ({
  buildRefresh: async (_db: unknown, source: { id: string }) =>
    refreshes.error
      ? { ok: false, error: refreshes.error }
      : { ok: true, write: { id: source.id, header: ['Name', 'Amount'], rows: refreshes.rows }, rowCount: refreshes.rows.length },
}));

const WORKSPACE = 'org_review_test';
const TAB = 'sh_tab';

let bucket: FakeBucket;
let state: ReturnType<typeof fakeObjectState>;
let env: Env;
const sheetId = 'sht_review';
const meta = () => ({ workspaceId: WORKSPACE, sheetId, snapshotKey: snapshotKeyFor(WORKSPACE, sheetId) });

function admission(userId: string, mode: 'edit' | 'comment' | 'view' = 'edit'): Admission {
  return { ...meta(), userId, name: userId, picture: null, color: '#2563eb', canEdit: mode === 'edit', canComment: mode === 'comment' };
}

async function join(room: SheetRoom, userId: string, mode: 'edit' | 'comment' | 'view' = 'edit'): Promise<FakeSocket> {
  const ticket = await room.admit(admission(userId, mode));
  const socket = new FakeSocket();
  expect(await room.accept(socket.asSocket(), ticket.split('.')[1]!)).toBe('ok');
  await send(room, socket, { type: 'hello', revision: null });
  return socket;
}

const send = (room: SheetRoom, socket: FakeSocket, msg: ClientMessage) => room.webSocketMessage(socket.asSocket(), encode(msg));
const ofType = <T extends ServerMessage['type']>(socket: FakeSocket, type: T) =>
  socket.messages().filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const comment = (over: Partial<SheetComment> = {}): SheetComment => ({
  id: 'c1',
  thread: 'c1',
  author: { id: 'alice', name: 'Alice' },
  createdAt: 1,
  body: 'Look @[Bob](bob)',
  mentions: ['bob'],
  cell: { row: 0, col: 0 },
  ...over,
});
const comments = (set: SheetComment[]): Op => ({ type: 'patchComments', sheetId: TAB, set });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(sheetDataSources);
  await db.delete(sheetVersions);
  await db.delete(sheets);
  await db.delete(files);
  notified.length = 0;
  refreshes.rows = [['Acme', 10]];
  refreshes.error = null;
  bucket = new FakeBucket();
  state = fakeObjectState();
  env = { PRIVATE_STORAGE: bucket.asBinding() } as unknown as Env;
  const workbook = new Workbook();
  workbook.sheets.push(new Sheet(TAB, 'Sheet1'));
  const size = await writeSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, sheetId), { revision: 0, workbook: workbook.toJSON() });
  await createSheet(db, { workspaceId: WORKSPACE, sheetId, name: 'Budget', folderId: null, userId: 'alice', snapshotSize: size });
});

describe('commenters and mentions', () => {
  it('lets a commenter add their own comments and nothing else', async () => {
    const room = new SheetRoom(state.ctx, env);
    const carol = await join(room, 'carol', 'comment');
    expect(ofType(carol, 'welcome')[0]!.canEdit).toBe(false);
    await send(room, carol, { type: 'submit', batchId: 'c:1', baseRevision: 0, op: comments([comment({ author: { id: 'carol', name: 'Carol' }, mentions: [] })]) });
    expect(ofType(carol, 'ack')).toEqual([{ type: 'ack', batchId: 'c:1', revision: 1 }]);
    await send(room, carol, { type: 'submit', batchId: 'c:2', baseRevision: 1, op: { type: 'setCells', sheetId: TAB, cells: [[0, 0, { v: 1 }]] } });
    expect(ofType(carol, 'reject')[0]).toMatchObject({ batchId: 'c:2', reason: 'read-only' });
  });

  it('notifies people a new comment mentions, once, when they can open the sheet and the author sent it', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: comments([comment()]) });
    await state.settle();
    expect(notified).toEqual([{ userId: 'bob', title: 'Alice mentioned you in Budget', actionUrl: `/weldsheets/${sheetId}?comment=c1` }]);
    // An edit that mentions nobody new notifies nobody; a comment in someone else's name notifies nobody.
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: comments([comment({ body: 'Look again @[Bob](bob)' })]) });
    await send(room, alice, { type: 'submit', batchId: 'a:3', baseRevision: 2, op: comments([comment({ id: 'c2', thread: 'c2', author: { id: 'dave', name: 'Dave' } })]) });
    await state.settle();
    expect(notified).toHaveLength(1);
  });
});

describe('versions', () => {
  it('saves the live workbook, and restores a version for everyone with an automatic version first', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: { type: 'setCells', sheetId: TAB, cells: [[0, 0, { v: 1 }]] } });
    const key = versionKeyFor(meta().snapshotKey, 'shtv_1');
    expect(await room.saveVersion(meta(), key)).toMatchObject({ revision: 1 });
    expect((await readSnapshot(bucket.asBinding(), key))?.revision).toBe(1);
    await db.insert(sheetVersions).values({ id: 'shtv_1', sheetId, revision: 1, name: 'First', snapshotKey: key, size: 1, createdById: 'alice' });

    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: { type: 'setCells', sheetId: TAB, cells: [[0, 0, { v: 2 }]] } });
    const outcome = await room.restoreVersion({ sheet: meta(), versionId: 'shtv_1', versionKey: key, autoVersionId: 'shtv_auto', userId: 'bob' });
    expect(outcome).toEqual({ ok: true, revision: 3 });
    for (const socket of [alice, bob]) {
      const restored = ofType(socket, 'restored')[0]!;
      expect(restored).toMatchObject({ revision: 3, versionId: 'shtv_1', userId: 'bob' });
      expect(Engine.fromSnapshot(restored.snapshot).getValue(TAB, 0, 0)).toBe(1);
    }
    const [auto] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, 'shtv_auto'));
    expect(auto).toMatchObject({ name: null, revision: 2, createdById: 'bob' });
    expect(Engine.fromSnapshot((await readSnapshot(bucket.asBinding(), auto!.snapshotKey))!.workbook).getValue(TAB, 0, 0)).toBe(2);
    expect((await readSnapshot(bucket.asBinding(), meta().snapshotKey))?.revision).toBe(3);

    // Edits continue on the restored workbook; a batch made on the old one resyncs.
    await send(room, alice, { type: 'submit', batchId: 'a:3', baseRevision: 3, op: { type: 'setCells', sheetId: TAB, cells: [[1, 0, { v: 5 }]] } });
    expect(ofType(alice, 'ack').at(-1)).toEqual({ type: 'ack', batchId: 'a:3', revision: 4 });
    // A restart replays nothing from before the restore.
    const restarted = new SheetRoom(fakeObjectStateFrom(state), env);
    expect((await restarted.readRange(meta(), { range: 'A1:A2' }))).toMatchObject({ ok: true, values: [[1], [5]] });
    expect(await room.restoreVersion({ sheet: meta(), versionId: 'x', versionKey: 'missing', autoVersionId: 'y', userId: 'bob' })).toEqual({ ok: false, reason: 'missing_version' });
  });
});

describe('server writes', () => {
  it('reads and writes ranges for agent tools, as an edit everyone sees', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const written = await room.writeRange(meta(), { range: 'B2', values: [[1, 2], ['=B2+C2', null]], userId: 'agent-user' });
    expect(written).toEqual({ ok: true, revision: 1, range: { r1: 1, c1: 1, r2: 2, c2: 2 }, tabId: TAB });
    expect(ofType(alice, 'op')[0]).toMatchObject({ revision: 1, clientId: 'server' });
    expect(await room.readRange(meta(), { tab: 'Sheet1' })).toMatchObject({ ok: true, tabName: 'Sheet1', values: [[1, 2], [3, null]], formulas: [[null, null], ['=B2+C2', null]] });
    expect(await room.tabs(meta())).toEqual([{ id: TAB, name: 'Sheet1', hidden: false, used: { r1: 1, c1: 1, r2: 2, c2: 2 } }]);
    expect(await room.readRange(meta(), { tab: 'Nope' })).toEqual({ ok: false, error: 'There is no tab "Nope"' });
    expect(await room.writeRange(meta(), { range: 'not a range', values: [[1]], userId: 'u' })).toMatchObject({ ok: false });
    expect(state.storage.data.get('lastEditor')).toBe('agent-user');
  });

  it('writes a connected table where it goes, and lets go of its block', async () => {
    const room = new SheetRoom(state.ctx, env);
    expect(await room.writeDataTable(meta(), { id: 'ds1', at: { sheetId: TAB, row: 2, col: 0 }, header: ['Name'], rows: [['Acme'], ['Bolt']] }, 'alice')).toEqual({ ok: true, revision: 1 });
    expect(await room.readRange(meta(), { range: 'A3:A5' })).toMatchObject({ values: [['Name'], ['Acme'], ['Bolt']] });
    expect(await room.writeDataTable(meta(), { id: 'ds2', header: ['x'], rows: [] }, 'alice')).toEqual({ ok: false, error: 'The table has no place in the workbook' });
    await room.dropDataTable(meta(), 'ds1', 'alice');
    const snapshot = JSON.parse((await room.snapshot(meta())).json) as { sheets: { dataTables?: unknown[] }[] };
    expect(snapshot.sheets[0]!.dataTables).toBeUndefined();
    expect(await room.readRange(meta(), { range: 'A4' })).toMatchObject({ values: [['Acme']] });
  });

  it('refreshes due connected tables on its alarm, and sets the next one', async () => {
    const room = new SheetRoom(state.ctx, env);
    await room.writeDataTable(meta(), { id: 'ds1', at: { sheetId: TAB, row: 0, col: 0 }, header: ['Name', 'Amount'], rows: [['Old', 1]] }, 'alice');
    const due = new Date(Date.now() - 1000);
    await db.insert(sheetDataSources).values({
      id: 'ds1',
      sheetId,
      objectType: 'companies',
      definition: { columns: ['name', 'employeeCount'], headers: ['Name', 'Amount'], filters: [], limit: 100 },
      refresh: 'hourly',
      nextRefreshAt: due,
      createdById: 'alice',
    });
    await room.scheduleRefresh(meta(), due.getTime());
    expect(state.storage.alarm).not.toBeNull();
    refreshes.rows = [['Acme', 10], ['Bolt', 20]];
    await room.alarm();
    expect(await room.readRange(meta(), { range: 'A1:B3' })).toMatchObject({ values: [['Name', 'Amount'], ['Acme', 10], ['Bolt', 20]] });
    const [row] = await db.select().from(sheetDataSources).where(eq(sheetDataSources.id, 'ds1'));
    expect(row).toMatchObject({ rowCount: 2, lastError: null });
    expect(row!.nextRefreshAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(state.storage.data.get('refreshAt')).toBe(row!.nextRefreshAt!.getTime());

    // A refresh that cannot happen is recorded, and the table stays as it was.
    await db.update(sheetDataSources).set({ nextRefreshAt: due }).where(eq(sheetDataSources.id, 'ds1'));
    await room.scheduleRefresh(meta(), due.getTime());
    refreshes.error = 'no_permission';
    await room.alarm();
    const [failed] = await db.select().from(sheetDataSources).where(eq(sheetDataSources.id, 'ds1'));
    expect(failed).toMatchObject({ lastError: 'no_permission', rowCount: 2 });
  });
});

/** The same stored state with no sockets and nothing in memory: a fresh start. */
function fakeObjectStateFrom(previous: ReturnType<typeof fakeObjectState>) {
  const next = fakeObjectState();
  for (const [k, v] of previous.storage.data) next.storage.data.set(k, v);
  return next.ctx;
}
