import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { boardVersions, files, whiteboards } from '@weldsuite/db/schema';
import { encode, type ClientMessage } from '@weldsuite/collab';
import { emptySnapshot, makeSticky, plain, type BoardElement, type BoardPresence, type Op } from '@weldsuite/board-engine';
import type { Env } from '../types';
import { FakeBucket, FakeSocket, fakeObjectState, type BoardServerMessage } from '../test-support/fakes';
import { createBoard, snapshotKeyFor } from '../services/boards';
import { versionKeyFor } from '../services/versions';
import { readSnapshot, readThumbnail, writeSnapshot } from './snapshot';
import { BoardRoom, type Admission } from './board-room';
import { connectToRoom, isConnectRequest } from './connect';

let db: Database;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
}));

const WORKSPACE = 'org_room_test';
const BOARD = 'brd_room';

let bucket: FakeBucket;
let state: ReturnType<typeof fakeObjectState>;
let env: Env;

const meta = () => ({ workspaceId: WORKSPACE, boardId: BOARD, snapshotKey: snapshotKeyFor(WORKSPACE, BOARD) });

function admission(userId: string, canEdit = true, canComment = false): Admission {
  return { ...meta(), userId, name: userId, picture: null, color: '#2563eb', canEdit, canComment };
}

/** Admits `userId` and connects a socket for them. */
async function join(room: BoardRoom, userId: string, canEdit = true, canComment = false): Promise<FakeSocket> {
  const ticket = await room.admit(admission(userId, canEdit, canComment));
  const socket = new FakeSocket();
  expect(await room.accept(socket.asSocket(), ticket.split('.')[1]!)).toBe('ok');
  return socket;
}

type Message = ClientMessage<Op, BoardPresence>;
const send = (room: BoardRoom, socket: FakeSocket, msg: Message) => room.webSocketMessage(socket.asSocket(), encode(msg));
const ofType = <T extends BoardServerMessage['type']>(socket: FakeSocket, type: T) =>
  socket.messages().filter((m): m is Extract<BoardServerMessage, { type: T }> => m.type === type);

const sticky = (id: string, text: string, by = 'alice'): BoardElement => makeSticky(0, 0, { createdBy: by }, { id, text });
const create = (...elements: BoardElement[]): Op => ({ type: 'create', elements });
const comment = (id: string, by: string): BoardElement => ({ id, type: 'comment', order: 'a5', x: 10, y: 10, w: 32, h: 32, createdBy: by, thread: `t_${id}` });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(boardVersions);
  await db.delete(whiteboards);
  await db.delete(files);
  bucket = new FakeBucket();
  state = fakeObjectState();
  env = { PRIVATE_STORAGE: bucket.asBinding() } as unknown as Env;
  const size = await writeSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, BOARD), { revision: 0, board: emptySnapshot() });
  await createBoard(db, { workspaceId: WORKSPACE, boardId: BOARD, name: 'Room test', folderId: null, userId: 'alice', snapshotSize: size });
});

describe('BoardRoom', () => {
  it('admits each ticket once', async () => {
    const room = new BoardRoom(state.ctx, env);
    const ticket = await room.admit(admission('alice'));
    const secret = ticket.split('.')[1]!;
    expect(ticket.split('.')[0]).toBe('a'.repeat(64));
    expect(await room.accept(new FakeSocket().asSocket(), secret)).toBe('ok');
    expect(await room.accept(new FakeSocket().asSocket(), secret)).toBe('invalid');
    expect(await room.accept(new FakeSocket().asSocket(), 'made-up')).toBe('invalid');
  });

  it('orders edits between people, logs them, and checkpoints with a thumbnail when everyone leaves', async () => {
    const room = new BoardRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, bob, { type: 'hello', revision: null });
    expect(ofType(alice, 'welcome')[0]).toMatchObject({ revision: 0, canEdit: true });

    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: create(sticky('s1', 'Idea')) });
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:1', revision: 1 }]);
    expect(ofType(bob, 'op')[0]).toMatchObject({ revision: 1, batchId: 'a:1' });
    expect(state.storage.data.has('op:000000000001')).toBe(true);
    expect(state.storage.alarm).not.toBeNull();

    // Evicted while both sockets stay open: a new instance picks up from checkpoint + log.
    const woken = new BoardRoom(state.ctx, env);
    await send(woken, bob, { type: 'submit', batchId: 'b:1', baseRevision: 1, op: { type: 'set', id: 's1', patch: { fill: '#bbf7d0' } } });
    expect(ofType(bob, 'ack').at(-1)).toMatchObject({ revision: 2 });
    expect(ofType(alice, 'op').at(-1)).toMatchObject({ revision: 2, batchId: 'b:1' });

    await woken.webSocketClose(alice.asSocket(), 1000, 'bye');
    await woken.webSocketClose(bob.asSocket(), 1000, 'bye');
    const stored = await readSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, BOARD));
    expect(stored?.revision).toBe(2);
    expect(stored?.board.elements.map((e) => [e.id, e.fill])).toEqual([['s1', '#bbf7d0']]);
    const [row] = await db.select().from(whiteboards).where(eq(whiteboards.id, BOARD));
    expect(row).toMatchObject({ revision: 2, snapshotRevision: 2, updatedById: 'bob' });
    const svg = await readThumbnail(bucket.asBinding(), snapshotKeyFor(WORKSPACE, BOARD));
    expect(svg).toContain('<svg');
    expect(svg).toContain('Idea');
  });

  it('lets a viewer only watch and a commenter only add and resolve comment pins', async () => {
    const room = new BoardRoom(state.ctx, env);
    const viewer = await join(room, 'vera', false);
    const commenter = await join(room, 'carl', false, true);
    const editor = await join(room, 'alice');
    for (const s of [viewer, commenter, editor]) await send(room, s, { type: 'hello', revision: null });

    await send(room, viewer, { type: 'submit', batchId: 'v:1', baseRevision: 0, op: create(comment('c0', 'vera')) });
    expect(ofType(viewer, 'reject')).toHaveLength(1);

    await send(room, commenter, { type: 'submit', batchId: 'c:1', baseRevision: 0, op: create(comment('c1', 'carl')) });
    expect(ofType(commenter, 'ack')).toEqual([{ type: 'ack', batchId: 'c:1', revision: 1 }]);
    await send(room, commenter, { type: 'submit', batchId: 'c:2', baseRevision: 1, op: create(sticky('s1', 'Not mine to add')) });
    expect(ofType(commenter, 'reject').map((r) => r.batchId)).toEqual(['c:2']);

    // Someone else's pin: resolving is fine, moving is not.
    await send(room, editor, { type: 'submit', batchId: 'a:1', baseRevision: 1, op: create(comment('c2', 'alice')) });
    await send(room, commenter, { type: 'submit', batchId: 'c:3', baseRevision: 2, op: { type: 'set', id: 'c2', patch: { resolved: true } } });
    expect(ofType(commenter, 'ack').at(-1)).toMatchObject({ batchId: 'c:3', revision: 3 });
    await send(room, commenter, { type: 'submit', batchId: 'c:4', baseRevision: 3, op: { type: 'set', id: 'c2', patch: { x: 99 } } });
    expect(ofType(commenter, 'reject').map((r) => r.batchId)).toEqual(['c:2', 'c:4']);
  });

  it('lets a commenter vote for themselves in an open round, never for someone else', async () => {
    const room = new BoardRoom(state.ctx, env);
    const editor = await join(room, 'alice');
    const commenter = await join(room, 'carl', false, true);
    for (const s of [editor, commenter]) await send(room, s, { type: 'hello', revision: null });
    await send(room, editor, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: create(sticky('s1', 'Idea')) });
    await send(room, editor, {
      type: 'submit',
      batchId: 'a:2',
      baseRevision: 1,
      op: { type: 'setBoard', patch: { voting: { id: 'v1', votesPerPerson: 2, anonymous: false, status: 'open' } } },
    });
    await send(room, commenter, { type: 'submit', batchId: 'c:1', baseRevision: 2, op: { type: 'vote', user: 'carl', elements: ['s1'] } });
    expect(ofType(commenter, 'ack').map((a) => a.batchId)).toEqual(['c:1']);
    await send(room, commenter, { type: 'submit', batchId: 'c:2', baseRevision: 3, op: { type: 'vote', user: 'alice', elements: ['s1'] } });
    expect(ofType(commenter, 'reject').map((r) => r.batchId)).toEqual(['c:2']);
    const live = JSON.parse((await room.snapshot(meta())).json);
    expect(live.votes).toEqual({ carl: ['s1'] });
  });

  it('commits server writes and sends them to everyone connected', async () => {
    const room = new BoardRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    const result = await room.applyOps(meta(), create(sticky('srv', 'From the API', 'bob')), 'bob');
    expect(result).toEqual({ revision: 1, committed: true });
    expect(ofType(alice, 'op').at(-1)).toMatchObject({ revision: 1, clientId: 'server:bob' });

    // An element that is already there cannot be created again.
    const refused = await room.applyOps(meta(), create(sticky('srv', 'Again', 'bob')), 'bob');
    expect(refused).toMatchObject({ revision: 1, committed: false });
    expect(refused.refused).toBeTruthy();
    // A change to an element someone deleted meanwhile is a no-op, not an error.
    expect(await room.applyOps(meta(), { type: 'set', id: 'gone', patch: { text: plain('x') } }, 'bob')).toMatchObject({ committed: true });
    const live = await room.snapshot(meta());
    expect(JSON.parse(live.json).elements.map((e: BoardElement) => e.id)).toEqual(['srv']);
    expect(await room.plainText(meta())).toContain('From the API');
  });

  it('saves versions and restores one, telling everyone', async () => {
    const room = new BoardRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: create(sticky('s1', 'First')) });
    const versionKey = versionKeyFor(meta().snapshotKey, 'brdv_1');
    const saved = await room.saveVersion(meta(), versionKey);
    expect(saved.revision).toBe(1);
    await db.insert(boardVersions).values({ id: 'brdv_1', boardId: BOARD, revision: 1, name: 'v1', snapshotKey: versionKey, size: saved.size });

    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: { type: 'delete', ids: ['s1'] } });
    const outcome = await room.restoreVersion({ board: meta(), versionId: 'brdv_1', versionKey, autoVersionId: 'brdv_auto', userId: 'alice' });
    expect(outcome).toEqual({ ok: true, revision: 3 });
    expect(ofType(alice, 'restored')).toMatchObject([{ revision: 3, versionId: 'brdv_1', userId: 'alice' }]);
    const live = JSON.parse((await room.snapshot(meta())).json);
    expect(live.elements.map((e: BoardElement) => e.id)).toEqual(['s1']);
    const [auto] = await db.select().from(boardVersions).where(eq(boardVersions.id, 'brdv_auto'));
    expect(auto).toMatchObject({ boardId: BOARD, revision: 2, name: null });
    const autoStored = await readSnapshot(bucket.asBinding(), auto!.snapshotKey);
    expect(autoStored?.board.elements).toEqual([]);
    expect(await room.restoreVersion({ board: meta(), versionId: 'x', versionKey: 'missing', autoVersionId: 'y', userId: 'alice' })).toEqual({
      ok: false,
      reason: 'missing_version',
    });
  });
});

describe('connect', () => {
  it('only takes WebSocket upgrades with a well-formed ticket', async () => {
    expect(isConnectRequest(new Request('https://board-api.test/api/boards/connect?ticket=x'))).toBe(true);
    expect(isConnectRequest(new Request('https://board-api.test/api/boards/brd_1'))).toBe(false);
    const plainGet = await connectToRoom(new Request('https://board-api.test/api/boards/connect'), env);
    expect(plainGet.status).toBe(426);
    const bad = await connectToRoom(new Request('https://board-api.test/api/boards/connect?ticket=nope', { headers: { Upgrade: 'websocket' } }), env);
    expect(bad.status).toBe(401);
  });
});
