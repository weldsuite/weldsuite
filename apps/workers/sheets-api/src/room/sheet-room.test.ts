import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { files, sheets } from '@weldsuite/db/schema';
import { Engine, Sheet, Workbook, encode, readXlsx, toFrames, type ClientMessage, type Op, type ServerMessage } from '@weldsuite/sheets-engine';
import type { Env } from '../types';
import { FakeBucket, FakeSocket, fakeObjectState } from '../test-support/fakes';
import { createSheet, snapshotKeyFor } from '../services/sheets';
import { readSnapshot, writeSnapshot } from './snapshot';
import { SheetRoom, replyCode, type Admission } from './sheet-room';
import { connectToRoom, isConnectRequest } from './connect';

let db: Database;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
}));

const WORKSPACE = 'org_room_test';
const TAB = 'sh_tab';

let bucket: FakeBucket;
let state: ReturnType<typeof fakeObjectState>;
let sheetId: string;
let env: Env;

function admission(userId: string, canEdit = true): Admission {
  return {
    workspaceId: WORKSPACE,
    sheetId,
    snapshotKey: snapshotKeyFor(WORKSPACE, sheetId),
    userId,
    name: userId,
    picture: null,
    color: '#2563eb',
    canEdit,
  };
}

/** Admits `userId` and connects a socket for them. */
async function join(room: SheetRoom, userId: string, canEdit = true): Promise<FakeSocket> {
  const ticket = await room.admit(admission(userId, canEdit));
  const socket = new FakeSocket();
  expect(await room.accept(socket.asSocket(), ticket.split('.')[1]!)).toBe('ok');
  return socket;
}

const send = (room: SheetRoom, socket: FakeSocket, msg: ClientMessage) => room.webSocketMessage(socket.asSocket(), encode(msg));
const setCell = (row: number, value: number): Op => ({ type: 'setCells', sheetId: TAB, cells: [[row, 0, { v: value }]] });
const ofType = <T extends ServerMessage['type']>(socket: FakeSocket, type: T) =>
  socket.messages().filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(sheets);
  await db.delete(files);
  bucket = new FakeBucket();
  state = fakeObjectState();
  env = { PRIVATE_STORAGE: bucket.asBinding() } as unknown as Env;
  sheetId = 'sht_room';
  const workbook = new Workbook();
  workbook.sheets.push(new Sheet(TAB, 'Sheet1'));
  const size = await writeSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, sheetId), { revision: 0, workbook: workbook.toJSON() });
  await createSheet(db, { workspaceId: WORKSPACE, sheetId, name: 'Room test', folderId: null, userId: 'alice', snapshotSize: size });
});

describe('SheetRoom', () => {
  it('admits each ticket once', async () => {
    const room = new SheetRoom(state.ctx, env);
    const ticket = await room.admit(admission('alice'));
    const secret = ticket.split('.')[1]!;
    expect(ticket.split('.')[0]).toBe('a'.repeat(64));
    expect(await room.accept(new FakeSocket().asSocket(), secret)).toBe('ok');
    expect(await room.accept(new FakeSocket().asSocket(), secret)).toBe('invalid');
    expect(await room.accept(new FakeSocket().asSocket(), 'made-up')).toBe('invalid');
  });

  it('orders edits between people, logs them and checkpoints when everyone leaves', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, bob, { type: 'hello', revision: null });
    expect(ofType(alice, 'welcome')[0]).toMatchObject({ revision: 0, canEdit: true });
    expect(ofType(alice, 'peerJoined')[0]!.peer.userId).toBe('bob');

    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: setCell(0, 7) });
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:1', revision: 1 }]);
    expect(ofType(bob, 'op')[0]).toMatchObject({ revision: 1, batchId: 'a:1' });
    expect(state.storage.data.has('op:000000000001')).toBe(true);
    expect(state.storage.alarm).not.toBeNull();

    // The object is evicted while both sockets stay open; a new instance picks up.
    const woken = new SheetRoom(state.ctx, env);
    await send(woken, bob, { type: 'submit', batchId: 'b:1', baseRevision: 1, op: setCell(1, 8) });
    expect(ofType(bob, 'ack').at(-1)).toMatchObject({ revision: 2 });
    expect(ofType(alice, 'op').at(-1)).toMatchObject({ revision: 2, batchId: 'b:1' });

    await woken.webSocketClose(alice.asSocket(), 1000, 'bye');
    expect(ofType(bob, 'peerLeft')).toHaveLength(1);
    await woken.webSocketClose(bob.asSocket(), 1000, 'bye');

    const stored = await readSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, sheetId));
    expect(stored?.revision).toBe(2);
    const engine = Engine.fromSnapshot(stored!.workbook);
    expect([engine.getValue(TAB, 0, 0), engine.getValue(TAB, 1, 0)]).toEqual([7, 8]);
    const [row] = await db.select().from(sheets).where(eq(sheets.id, sheetId));
    expect(row).toMatchObject({ revision: 2, snapshotRevision: 2, updatedById: 'bob' });
  });

  it('replays the log over the checkpoint after a restart', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: setCell(0, 1) });
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: setCell(0, 2) });

    const restarted = new SheetRoom(fakeObjectStateFrom(state), env);
    const carol = await join(restarted, 'carol');
    await send(restarted, carol, { type: 'hello', revision: null });
    const welcome = ofType(carol, 'welcome')[0]!;
    expect(welcome.revision).toBe(2);
    expect(Engine.fromSnapshot(welcome.snapshot!).getValue(TAB, 0, 0)).toBe(2);
    // Alice's batch, re-sent after a reconnect, is acknowledged and not applied again.
    await send(restarted, carol, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: setCell(0, 2) });
    expect(ofType(carol, 'ack').at(-1)).toEqual({ type: 'ack', batchId: 'a:2', revision: 2 });
  });

  it('answers a close without a code with a normal close', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await room.webSocketClose(alice.asSocket(), 1005, '');
    expect(alice.closed).toEqual({ code: 1000, reason: '' });
    expect([1000, 1001, 4001, 1005, 1006, 1015, 999, 5000].map(replyCode)).toEqual([1000, 1001, 4001, 1000, 1000, 1000, 1000, 1000]);
  });

  it('keeps viewers from editing', async () => {
    const room = new SheetRoom(state.ctx, env);
    const viewer = await join(room, 'vic', false);
    await send(room, viewer, { type: 'hello', revision: null });
    expect(ofType(viewer, 'welcome')[0]!.canEdit).toBe(false);
    await send(room, viewer, { type: 'submit', batchId: 'v:1', baseRevision: 0, op: setCell(0, 9) });
    expect(ofType(viewer, 'reject')[0]).toMatchObject({ reason: 'read-only' });
    expect(state.storage.data.has('op:000000000001')).toBe(false);
  });

  it('refuses a garbled batch and logs nothing', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    const garbled = { type: 'submit', batchId: 'a:1', baseRevision: 0, op: { type: 'batch', ops: [setCell(0, 5), { type: 'setNames', names: null }] } };
    await room.webSocketMessage(alice.asSocket(), JSON.stringify(garbled));
    // Never applied or logged; the sender is told, and gets the room's state back.
    expect(alice.messages().map((m) => m.type)).toEqual(['welcome', 'reject', 'resync']);
    expect(state.storage.data.has('op:000000000001')).toBe(false);
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 0, op: setCell(0, 6) });
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:2', revision: 1 }]);
  });

  it('rebuilds itself when an op fails to apply', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, bob, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: setCell(0, 1) });
    const loaded = (room as unknown as { room: { engine: Engine } }).room;
    vi.spyOn(loaded.engine, 'setNames').mockImplementation(() => {
      throw new Error('engine bug');
    });
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: { type: 'batch', ops: [setCell(0, 2), { type: 'setNames', names: [] }] } });
    expect(ofType(alice, 'reject')).toEqual([{ type: 'reject', batchId: 'a:2', reason: 'invalid' }]);
    expect([alice.closed?.code, bob.closed?.code]).toEqual([1012, 1012]);
    expect(state.storage.data.has('op:000000000002')).toBe(false);

    // Everyone comes back to a room rebuilt from the checkpoint and the log.
    state.sockets.length = 0;
    const again = await join(room, 'alice');
    await send(room, again, { type: 'hello', revision: 1 });
    expect(ofType(again, 'welcome')[0]).toMatchObject({ revision: 1, catchUp: [] });
    await send(room, again, { type: 'submit', batchId: 'a:3', baseRevision: 1, op: setCell(0, 3) });
    expect(ofType(again, 'ack')).toEqual([{ type: 'ack', batchId: 'a:3', revision: 2 }]);
  });

  it('joins a batch sent in parts', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    const cells = Array.from({ length: 200 }, (_, i) => [i, 1, { v: `value ${i}` }] as [number, number, { v: string }]);
    const frames = toFrames(encode({ type: 'submit', batchId: 'a:big', baseRevision: 0, op: { type: 'setCells', sheetId: TAB, cells } }), 'p1', 1000);
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) await room.webSocketMessage(alice.asSocket(), frame);
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:big', revision: 1 }]);
  });

  const meta = () => ({ workspaceId: WORKSPACE, sheetId, snapshotKey: snapshotKeyFor(WORKSPACE, sheetId) });
  const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true, fatal: false }).decode(bytes);

  it('exports its live workbook, edits not checkpointed yet included', async () => {
    const room = new SheetRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: setCell(0, 7.5) });

    const xlsx = await room.exportFile(meta(), { format: 'xlsx' });
    expect(xlsx?.tabName).toBeNull();
    const { workbook } = await readXlsx(xlsx!.bytes);
    expect(workbook.sheets[0]!.cells).toEqual([[0, 0, { v: 7.5 }]]);

    const csv = await room.exportFile(meta(), { format: 'csv', locale: 'nl' });
    expect(csv?.tabName).toBe('Sheet1');
    expect(text(csv!.bytes)).toBe('\uFEFF7,5\r\n');
    expect(await room.exportFile(meta(), { format: 'csv', tab: 'sh_nope' })).toBeNull();
  });

  it('exports a sheet nobody has open, from its checkpoint', async () => {
    const room = new SheetRoom(state.ctx, env);
    const csv = await room.exportFile(meta(), { format: 'csv', tab: TAB });
    expect(text(csv!.bytes)).toBe('\uFEFF');
    expect(state.storage.data.get('meta')).toEqual(meta());
  });
});

describe('room socket', () => {
  const upgrade = (ticket: string) =>
    new Request(`https://sheets-api.test/api/sheets/connect?ticket=${ticket}`, { headers: { Upgrade: 'websocket' } });

  it('forwards a well-formed ticket to the room it names', async () => {
    const fetched: string[] = [];
    const roomEnv = {
      SHEET_ROOM: {
        idFromString: (id: string) => ({ id }),
        get: ({ id }: { id: string }) => ({ fetch: async () => (fetched.push(id), new Response('ok')) }),
      },
    } as unknown as Env;
    expect(isConnectRequest(upgrade('x'))).toBe(true);
    expect((await connectToRoom(upgrade(`${'b'.repeat(64)}.secret-secret-secret`), roomEnv)).status).toBe(200);
    expect(fetched).toEqual(['b'.repeat(64)]);
    expect((await connectToRoom(upgrade('nope'), roomEnv)).status).toBe(401);
    expect((await connectToRoom(new Request('https://sheets-api.test/api/sheets/connect'), roomEnv)).status).toBe(426);
  });
});

/** The same stored state with no sockets and nothing in memory: a fresh start. */
function fakeObjectStateFrom(previous: ReturnType<typeof fakeObjectState>) {
  const next = fakeObjectState();
  for (const [k, v] of previous.storage.data) next.storage.data.set(k, v);
  return next.ctx;
}
