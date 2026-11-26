import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OtAdapter } from './adapter';
import { readCheckpoint, writeCheckpoint } from './checkpoint';
import {
  CollabRoom,
  replyCode,
  type AdmittedPeer,
  type AutoVersion,
  type CheckpointRecord,
  type RoomMeta,
  type VersionRestore,
} from './durable-room';
import { encode, toFrames, type ClientMessage, type CommittedOp, type ServerMessage } from './protocol';
import { RoomCore, type RoomOptions } from './room';
import { FakeBucket, FakeSocket, fakeObjectState } from './test-support/fakes';
import { listAdapter, type Cursor, type ListOp, type ListState } from './test-support/list-adapter';

// A room around the toy list document: its checkpoints are `{ revision, items }`,
// and the tenant DB is two arrays on the env.

interface ListMeta extends RoomMeta {
  listId: string;
}

interface ListEnv {
  BUCKET: R2Bucket;
  versions: AutoVersion[];
  records: { checkpoint: CheckpointRecord; announce: boolean }[];
  failRecord?: boolean;
}

/** The list adapter, except that inserting `explode` throws halfway (an engine bug the checks miss). */
const adapter: OtAdapter<ListState, ListOp, string[], Cursor> = {
  ...listAdapter,
  apply: (state, op) => {
    if (op.type === 'ins' && op.item === 'explode') throw new Error('the engine broke');
    return listAdapter.apply(state, op);
  },
};

class ListRoom extends CollabRoom<ListEnv, ListMeta, ListState, ListOp, string[], Cursor> {
  protected readonly logPrefix = '[test/room]';
  protected readonly noun = 'list';
  protected readonly shapeChecks = listAdapter;

  admit(admission: ListMeta & AdmittedPeer): Promise<string> {
    const { workspaceId, listId, snapshotKey, ...peer } = admission;
    return this.issueTicket({ workspaceId, listId, snapshotKey }, peer);
  }

  restoreVersion(request: VersionRestore & { list: ListMeta }) {
    return this.restoreTo(request.list, request);
  }

  async write(meta: ListMeta, op: ListOp, userId: string) {
    return this.commitServerOp(await this.roomFor(meta), op, 'server', userId);
  }

  protected createRoom(snapshot: string[], revision: number, ops: CommittedOp<ListOp>[], options: RoomOptions<ListOp, ListState, Cursor>) {
    return RoomCore.restore(adapter, snapshot, revision, ops, options);
  }

  protected emptySnapshot(): string[] {
    return [];
  }

  protected snapshotOf(room: RoomCore<ListState, ListOp, string[], Cursor>): string[] {
    return [...room.state.items];
  }

  protected async readStored(key: string) {
    const stored = await readCheckpoint<{ revision: number; items: string[] }>(this.env.BUCKET, key);
    return stored && { revision: stored.revision, snapshot: stored.items };
  }

  protected writeStored(key: string, revision: number, items: string[]): Promise<number> {
    return writeCheckpoint(this.env.BUCKET, key, { revision, items });
  }

  protected versionKeyFor(snapshotKey: string, versionId: string): string {
    return `${snapshotKey}/versions/${versionId}`;
  }

  protected async saveAutoVersion(_meta: ListMeta, version: AutoVersion): Promise<void> {
    this.env.versions.push(version);
  }

  protected async recordCheckpoint(_meta: ListMeta, checkpoint: CheckpointRecord, announce: boolean): Promise<void> {
    if (this.env.failRecord) throw new Error('the tenant DB is down');
    this.env.records.push({ checkpoint, announce });
  }
}

/** Commenters may add `#` items; a rule that throws stands for a bug in one. */
class CommentedListRoom extends ListRoom {
  protected accessRules() {
    return {
      mayComment: (op: ListOp) => {
        if (op.type === 'ins' && op.item === 'throw') throw new Error('the rule broke');
        return op.type === 'ins' && op.item.startsWith('#');
      },
    };
  }
}

type Message = ServerMessage<ListOp, string[], Cursor>;

let state: ReturnType<typeof fakeObjectState>;
let bucket: FakeBucket;
let env: ListEnv;
const meta: ListMeta = { workspaceId: 'ws_test', listId: 'list_1', snapshotKey: 'lists/list_1/list.json.gz' };

async function join(room: ListRoom, userId: string, rights: { canEdit?: boolean; canComment?: boolean } = {}): Promise<FakeSocket> {
  const ticket = await room.admit({ ...meta, userId, name: userId, picture: null, color: '#2563eb', canEdit: rights.canEdit ?? true, canComment: rights.canComment ?? false });
  const socket = new FakeSocket();
  expect(await room.accept(socket.asSocket(), ticket.split('.')[1]!)).toBe('ok');
  await send(room, socket, { type: 'hello', revision: null });
  return socket;
}

const send = (room: ListRoom, socket: FakeSocket, msg: ClientMessage<ListOp, Cursor>) => room.webSocketMessage(socket.asSocket(), encode(msg));
const insert = (room: ListRoom, socket: FakeSocket, batchId: string, baseRevision: number, item: string, at = 0) =>
  send(room, socket, { type: 'submit', batchId, baseRevision, op: { type: 'ins', at, item } });
const ofType = <T extends Message['type']>(socket: FakeSocket, type: T) =>
  socket.messages<ListOp, string[], Cursor>().filter((m): m is Extract<Message, { type: T }> => m.type === type);
const stored = () => readCheckpoint<{ revision: number; items: string[] }>(bucket.asBinding(), meta.snapshotKey);
const logged = () => [...state.storage.data.keys()].filter((k) => k.startsWith('op:'));
const logs = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  state = fakeObjectState();
  bucket = new FakeBucket();
  env = { BUCKET: bucket.asBinding(), versions: [], records: [] };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CollabRoom admission', () => {
  it('admits each ticket once, and not after it expires', async () => {
    const room = new ListRoom(state.ctx, env);
    const ticket = await room.admit({ ...meta, userId: 'alice', name: 'Alice', picture: null, color: '#000', canEdit: true, canComment: false });
    const [roomId, secret] = ticket.split('.');
    expect(roomId).toBe('a'.repeat(64));
    expect(await room.accept(new FakeSocket().asSocket(), secret!)).toBe('ok');
    expect(await room.accept(new FakeSocket().asSocket(), secret!)).toBe('invalid');
    expect(await room.accept(new FakeSocket().asSocket(), null)).toBe('invalid');

    const late = (await room.admit({ ...meta, userId: 'bob', name: 'Bob', picture: null, color: '#000', canEdit: true, canComment: false })).split('.')[1]!;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(await room.accept(new FakeSocket().asSocket(), late)).toBe('invalid');
    // The next admission sweeps out tickets that expired unused.
    const fresh = (await room.admit({ ...meta, userId: 'cara', name: 'Cara', picture: null, color: '#000', canEdit: true, canComment: false })).split('.')[1]!;
    expect([...state.storage.data.keys()].filter((k) => k.startsWith('ticket:'))).toEqual([`ticket:${fresh}`]);
    expect(state.storage.data.get('meta')).toEqual(meta);
  });

  it('answers a request that is not a socket, a bad ticket and a document it cannot load over HTTP', async () => {
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new FakeSocket();
        1 = new FakeSocket();
      },
    );
    const room = new ListRoom(state.ctx, env);
    expect((await room.fetch(new Request('https://room/connect'))).status).toBe(426);
    const upgrade = (ticket: string) => new Request(`https://room/connect?ticket=${ticket}`, { headers: { Upgrade: 'websocket' } });
    expect((await room.fetch(upgrade('room.made-up'))).status).toBe(401);

    const ticket = await room.admit({ ...meta, userId: 'alice', name: 'Alice', picture: null, color: '#000', canEdit: true, canComment: false });
    vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('R2 is down'));
    const res = await room.fetch(upgrade(ticket));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('List unavailable');
    expect(logs()).toContain('[test/room] loading the list failed:');
  });
});

describe('CollabRoom editing', () => {
  it('orders edits, logs them and checkpoints when the last person leaves', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    expect(ofType(alice, 'welcome')[0]).toMatchObject({ revision: 0, canEdit: true });

    await insert(room, alice, 'a:1', 0, 'x');
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:1', revision: 1 }]);
    expect(ofType(bob, 'op')[0]).toMatchObject({ revision: 1, batchId: 'a:1' });
    expect(logged()).toEqual(['op:000000000001']);
    expect(state.storage.data.get('lastEditor')).toBe('alice');
    expect(state.storage.alarm).toBeGreaterThan(Date.now());

    // 1005 (no code) may not be sent back; it gets a normal close.
    await room.webSocketClose(alice.asSocket(), 1005, '');
    expect(alice.closed).toEqual({ code: 1000, reason: '' });
    expect(ofType(bob, 'peerLeft')).toHaveLength(1);
    expect(env.records).toEqual([]);
    await room.webSocketError(bob.asSocket());
    expect(bob.closed).toEqual({ code: 1011, reason: 'error' });

    expect(await stored()).toEqual({ revision: 1, items: ['x'] });
    expect(env.records).toEqual([
      { checkpoint: { revision: 1, snapshotKey: meta.snapshotKey, size: expect.any(Number), userId: 'alice' }, announce: true },
    ]);
  });

  it('wakes up with its sockets still open and replays the log, ops too big for one value included', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const big = 'y'.repeat(1_100_000);
    const frames = toFrames(encode({ type: 'submit', batchId: 'a:1', baseRevision: 0, op: { type: 'ins', at: 0, item: big } }), 'big');
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) await room.webSocketMessage(alice.asSocket(), frame);
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:1', revision: 1 }]);
    expect(logged()).toEqual(['op:000000000001', 'op:000000000001:0', 'op:000000000001:1']);

    // The object is evicted; a new instance picks up the socket and the log.
    const woken = new ListRoom(state.ctx, env);
    await insert(woken, alice, 'a:2', 1, 'z');
    expect(ofType(alice, 'ack').at(-1)).toEqual({ type: 'ack', batchId: 'a:2', revision: 2 });
    const live = await woken.snapshot(meta);
    expect(live.revision).toBe(2);
    expect(JSON.parse(live.json)).toEqual(['z', big]);
  });

  it('checkpoints every 200 edits, and on the alarm', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    for (let i = 0; i < 200; i++) await insert(room, alice, `a:${i}`, i, `item ${i}`);
    // One more lands while that checkpoint is being written; the next one takes it.
    await insert(room, alice, 'a:200', 200, 'late');
    await vi.waitFor(() => expect(env.records).toHaveLength(1));
    expect(env.records[0]!.checkpoint.revision).toBe(200);

    await room.alarm();
    expect(env.records.at(-1)!.checkpoint.revision).toBe(201);
    expect((await stored())?.revision).toBe(201);

    // A fresh instance loads the room before it checks for anything to write.
    await new ListRoom(state.ctx, env).alarm();
    expect(env.records).toHaveLength(2);
  });

  it('leaves an alarm that is already set alone', async () => {
    const later = Date.now() + 3_600_000;
    state.storage.alarm = later;
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await insert(room, alice, 'a:1', 0, 'x');
    await vi.waitFor(() => expect(state.storage.data.get('lastEditor')).toBe('alice'));
    expect(state.storage.alarm).toBe(later);
  });

  it('commits server writes like anyone’s edit', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const written = await room.write(meta, { type: 'ins', at: 0, item: 'from the server' }, 'agent');
    expect(written.committed).toMatchObject({ revision: 1, clientId: 'server' });
    expect(ofType(alice, 'op')[0]).toMatchObject({ revision: 1, op: { type: 'ins', item: 'from the server' } });
    await vi.waitFor(() => expect(state.storage.data.get('lastEditor')).toBe('agent'));

    expect(await room.write(meta, { type: 'nope' } as unknown as ListOp, 'agent')).toMatchObject({ committed: null, refused: 'malformed op' });

    const broken = await room.write(meta, { type: 'ins', at: 0, item: 'explode' }, 'agent');
    expect(broken).toMatchObject({ committed: null, refused: 'the op failed to apply' });
    expect(alice.closed).toEqual({ code: 1012, reason: 'Reloading the list' });
    expect(logs()).toContain('[test/room] a server op failed to apply; rebuilding the room from its checkpoint');
  });
});

describe('CollabRoom when something goes wrong', () => {
  it('ignores what it cannot read, and answers a malformed batch', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const before = alice.frames.length;
    await room.webSocketMessage(alice.asSocket(), new ArrayBuffer(4));
    await room.webSocketMessage(alice.asSocket(), 'not json');
    expect(alice.frames).toHaveLength(before);

    await room.webSocketMessage(alice.asSocket(), JSON.stringify({ type: 'submit', batchId: 'a:1', baseRevision: 0, op: { type: 'nope' } }));
    expect(alice.messages().slice(-2).map((m) => m.type)).toEqual(['reject', 'resync']);

    // A socket the room never admitted has no peer: nothing happens, but its close is answered.
    const stranger = new FakeSocket();
    await room.webSocketMessage(stranger.asSocket(), encode({ type: 'ping' }));
    await room.webSocketClose(stranger.asSocket(), 4000, 'bye');
    expect(stranger.frames).toEqual([]);
    expect(stranger.closed).toEqual({ code: 4000, reason: 'bye' });
  });

  it('rebuilds the room when an op fails to apply, closing every socket', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await insert(room, alice, 'a:1', 0, 'kept');
    bob.gone = true; // sends and closes throw: the room carries on
    await insert(room, alice, 'a:2', 1, 'explode');
    expect(ofType(alice, 'reject')).toEqual([{ type: 'reject', batchId: 'a:2', reason: 'invalid' }]);
    expect(alice.closed).toEqual({ code: 1012, reason: 'Reloading the list' });
    expect(logs()).toContain('[test/room] an op failed to apply; rebuilding the room from its checkpoint');

    // The rebuilt room has the committed edit and not the broken one.
    expect(JSON.parse((await room.snapshot(meta)).json)).toEqual(['kept']);
  });

  it('closes a socket when the document cannot be loaded', async () => {
    const room = new ListRoom(state.ctx, env);
    const socket = new FakeSocket();
    socket.serializeAttachment({ peer: { clientId: 'c1', userId: 'alice', name: 'Alice', color: '#000', canEdit: true }, ready: true });
    // No admission ever told this room which list it holds.
    await room.webSocketMessage(socket.asSocket(), encode({ type: 'ping' }));
    expect(socket.closed).toEqual({ code: 1011, reason: 'List unavailable' });
    expect(logs()).toContain('[test/room] loading the list failed:');
    await room.webSocketClose(socket.asSocket(), 1000, 'bye');
    expect(env.records).toEqual([]);
  });

  it('logs a checkpoint it could not record; the checkpoint itself is in R2', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await insert(room, alice, 'a:1', 0, 'x');
    env.failRecord = true;
    await room.alarm();
    expect(await stored()).toEqual({ revision: 1, items: ['x'] });
    expect(logs()).toContain('[test/room] recording the checkpoint failed:');
  });
});

describe('CollabRoom commenters', () => {
  it('commits only what the rules let a commenter commit', async () => {
    const room = new CommentedListRoom(state.ctx, env);
    const cara = await join(room, 'cara', { canEdit: false, canComment: true });
    const viewer = await join(room, 'vic', { canEdit: false });
    await insert(room, cara, 'c:1', 0, '#note');
    expect(ofType(cara, 'ack')).toEqual([{ type: 'ack', batchId: 'c:1', revision: 1 }]);
    await insert(room, cara, 'c:2', 1, 'plain');
    expect(ofType(cara, 'reject')).toEqual([{ type: 'reject', batchId: 'c:2', reason: 'read-only' }]);
    await insert(room, viewer, 'v:1', 1, '#note');
    expect(ofType(viewer, 'reject')).toEqual([{ type: 'reject', batchId: 'v:1', reason: 'read-only' }]);

    // A rule that throws: the room stops trusting itself and reloads.
    await insert(room, cara, 'c:3', 1, 'throw');
    expect(cara.closed).toEqual({ code: 1012, reason: 'Reloading the list' });
    expect(logs()).toContain('[test/room] handling a message failed:');
  });
});

describe('CollabRoom versions', () => {
  const restore = (room: ListRoom, versionKey: string, userId = 'bob') =>
    room.restoreVersion({ list: meta, versionId: 'v1', versionKey, autoVersionId: 'auto1', userId });

  it('saves the live document as a version and restores it, telling everyone connected', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await insert(room, alice, 'a:1', 0, 'a');
    await insert(room, alice, 'a:2', 1, 'b', 1);
    expect(await room.snapshot(meta)).toEqual({ revision: 2, json: '["a","b"]' });
    const saved = await room.saveVersion(meta, 'versions/v1');
    expect(saved).toEqual({ revision: 2, size: expect.any(Number) });
    await insert(room, alice, 'a:3', 2, 'c');

    const outcome = await restore(room, 'versions/v1');
    expect(outcome).toEqual({ ok: true, revision: 4 });
    // What it replaced is an automatic version, so the restore can be undone.
    const autoKey = `${meta.snapshotKey}/versions/auto1`;
    expect(env.versions).toEqual([{ id: 'auto1', revision: 3, snapshotKey: autoKey, size: expect.any(Number), createdById: 'bob' }]);
    expect(await readCheckpoint(bucket.asBinding(), autoKey)).toEqual({ revision: 3, items: ['c', 'a', 'b'] });
    expect(await stored()).toEqual({ revision: 4, items: ['a', 'b'] });
    expect(ofType(alice, 'restored')).toEqual([{ type: 'restored', revision: 4, snapshot: ['a', 'b'], versionId: 'v1', userId: 'bob' }]);
    expect(logged()).toEqual([]);
    expect(state.storage.data.get('logFloor')).toBe(4);
    expect(env.records.at(-1)).toEqual({ checkpoint: { revision: 4, snapshotKey: meta.snapshotKey, size: expect.any(Number), userId: 'bob' }, announce: false });

    // An op left over from the replaced document is never replayed.
    await state.storage.put('op:000000000003', { revision: 3, batchId: 'old', clientId: 'old', op: { type: 'ins', at: 0, item: 'old' } });
    expect(await new ListRoom(state.ctx, env).snapshot(meta)).toEqual({ revision: 4, json: '["a","b"]' });

    expect(await restore(room, 'versions/missing')).toEqual({ ok: false, reason: 'missing_version' });
    // A restore can be what wakes the room up.
    expect(await restore(new ListRoom(state.ctx, env), 'versions/missing')).toEqual({ ok: false, reason: 'missing_version' });
  });

  it('holds edits that arrive during a restore until it is done', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await insert(room, alice, 'a:1', 0, 'a');
    await room.saveVersion(meta, 'versions/v1');
    // The restore waits on R2 for the version; an edit comes in meanwhile.
    let release = () => {};
    const read = bucket.get.bind(bucket);
    const get = vi.spyOn(bucket, 'get').mockImplementationOnce(async (key) => {
      await new Promise<void>((resolve) => (release = resolve));
      return read(key);
    });
    const restoring = restore(room, 'versions/v1');
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    const editing = insert(room, alice, 'a:2', 2, 'after');
    release();
    await Promise.all([restoring, editing]);
    expect(ofType(alice, 'ack').at(-1)).toEqual({ type: 'ack', batchId: 'a:2', revision: 3 });
    expect(JSON.parse((await room.snapshot(meta)).json)).toEqual(['after', 'a']);
  });

  it('keeps the document as it was when the restored one cannot be written', async () => {
    const room = new ListRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await insert(room, alice, 'a:1', 0, 'a');
    await room.saveVersion(meta, 'versions/v1');
    await insert(room, alice, 'a:2', 1, 'b');
    await room.alarm();
    bucket.failing.add(meta.snapshotKey);
    await expect(restore(room, 'versions/v1')).rejects.toThrow('R2 put');
    expect(state.storage.data.get('logFloor')).toBe(0);
    expect(await stored()).toEqual({ revision: 2, items: ['b', 'a'] });

    bucket.failing.clear();
    env.failRecord = true;
    expect(await restore(room, 'versions/v1')).toEqual({ ok: true, revision: 3 });
    expect(logs()).toContain('[test/room] recording the restore failed:');
  });
});

describe('replyCode', () => {
  it('answers reserved close codes with a normal close', () => {
    expect([1000, 1001, 1005, 1006, 1011, 1015, 2000, 3000, 4999, 5000].map(replyCode)).toEqual([1000, 1001, 1000, 1000, 1011, 1000, 1000, 3000, 4999, 1000]);
  });
});
