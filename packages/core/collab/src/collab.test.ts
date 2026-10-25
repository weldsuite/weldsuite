import { describe, expect, it } from 'vitest';
import type { OtAdapter } from './adapter';
import { CollabClient } from './client';
import {
  FrameAssembler,
  decodeClient,
  decodeServer,
  encode,
  refusedBatchId,
  toFrames,
  type ClientMessage,
  type CommittedOp,
  type ServerMessage,
} from './protocol';
import { RoomCore, type Outgoing } from './room';

// A toy document for the protocol: a list of strings, edited by inserting and
// deleting items. Small enough to transform by hand, rich enough to conflict.

type Step = { type: 'ins'; at: number; item: string } | { type: 'del'; at: number };
type ListOp = Step | { type: 'batch'; ops: ListOp[] };
type Cursor = { index: number };
type ListState = { items: string[] };

const NOOP: ListOp = { type: 'batch', ops: [] };

function flatten(op: ListOp): Step[] {
  return op.type === 'batch' ? op.ops.flatMap(flatten) : [op];
}

function applyList(state: ListState, op: ListOp): ListOp {
  switch (op.type) {
    case 'ins':
      if (op.at < 0 || op.at > state.items.length) throw new Error('insert out of range');
      state.items.splice(op.at, 0, op.item);
      return { type: 'del', at: op.at };
    case 'del': {
      if (op.at < 0 || op.at >= state.items.length) throw new Error('delete out of range');
      const [item] = state.items.splice(op.at, 1);
      return { type: 'ins', at: op.at, item: item! };
    }
    case 'batch':
      return { type: 'batch', ops: op.ops.map((o) => applyList(state, o)).reverse() };
  }
}

function transformList(a: ListOp, b: ListOp, aWins: boolean): ListOp {
  if (b.type === 'batch') return b.ops.reduce((acc, bi) => transformList(acc, bi, aWins), a);
  if (a.type === 'batch') {
    let against: ListOp = b;
    const ops = a.ops.map((ai) => {
      const t = transformList(ai, against, aWins);
      against = transformList(against, ai, !aWins);
      return t;
    });
    return { type: 'batch', ops };
  }
  if (a.type === 'ins') {
    if (b.type === 'ins') return a.at > b.at || (a.at === b.at && aWins) ? { ...a, at: a.at + 1 } : a;
    return a.at > b.at ? { ...a, at: a.at - 1 } : a;
  }
  if (b.type === 'ins') return a.at >= b.at ? { ...a, at: a.at + 1 } : a;
  if (a.at === b.at) return NOOP;
  return a.at > b.at ? { ...a, at: a.at - 1 } : a;
}

function isListOp(v: unknown, depth = 0): v is ListOp {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.type === 'batch') return depth < 3 && Array.isArray(o.ops) && o.ops.every((x) => isListOp(x, depth + 1));
  if (o.type === 'del') return Number.isInteger(o.at);
  return o.type === 'ins' && Number.isInteger(o.at) && typeof o.item === 'string';
}

const listAdapter: OtAdapter<ListState, ListOp, string[], Cursor> = {
  load: (snapshot) => ({ items: [...snapshot] }),
  snapshot: (state) => [...state.items],
  apply: applyList,
  transform: transformList,
  normalize: (op) => {
    const ops = flatten(op);
    return ops.length === 1 ? ops[0]! : { type: 'batch', ops };
  },
  batch: (ops) => ({ type: 'batch', ops }),
  unbatch: (op) => (op.type === 'batch' ? op.ops : [op]),
  isWellFormedOp: (v): v is ListOp => isListOp(v),
  validate: (state, op) => {
    let length = state.items.length;
    for (const o of flatten(op)) {
      if (o.type === 'ins' ? o.at < 0 || o.at > length : o.at < 0 || o.at >= length) return 'out of range';
      length += o.type === 'ins' ? 1 : -1;
    }
    return null;
  },
  isPresence: (v): v is Cursor => typeof v === 'object' && v !== null && Number.isInteger((v as Cursor).index),
};

type Client = CollabClient<ListState, ListOp, string[], Cursor>;

/** A room and clients joined by FIFO queues whose delivery the test controls. */
class Network {
  readonly room: RoomCore<ListState, ListOp, string[], Cursor>;
  readonly clients: Client[] = [];
  private readonly connection: (string | null)[] = [];
  private readonly toRoom: ClientMessage<ListOp, Cursor>[][] = [];
  private readonly toClient: ServerMessage<ListOp, string[], Cursor>[][] = [];
  private connections = 0;

  constructor(count: number, readOnly: number[] = [], onCommit?: (c: CommittedOp<ListOp>) => void) {
    this.room = new RoomCore(listAdapter, ['a', 'b', 'c'], 0, { maxLog: 50, onCommit });
    for (let i = 0; i < count; i++) {
      this.toRoom.push([]);
      this.toClient.push([]);
      this.connection.push(null);
      this.clients.push(new CollabClient(listAdapter, { send: (msg) => this.toRoom[i]!.push(msg), sessionId: `client${i}` }));
      this.connect(i, !readOnly.includes(i));
    }
  }

  connect(i: number, canEdit = true): void {
    const clientId = `conn${++this.connections}`;
    this.connection[i] = clientId;
    this.room.join({ clientId, userId: `u${i}`, name: `User ${i}`, color: '#000', canEdit });
    this.clients[i]!.start();
  }

  disconnect(i: number): void {
    const id = this.connection[i];
    if (!id) return;
    this.dispatch(this.room.leave(id));
    this.connection[i] = null;
    this.toRoom[i] = [];
    this.toClient[i] = [];
  }

  connected(i: number): boolean {
    return this.connection[i] !== null;
  }

  deliverToRoom(i: number): boolean {
    const id = this.connection[i];
    const sent = this.toRoom[i]!.shift();
    if (!id || !sent) return false;
    // Through JSON and the same checks a Durable Object applies to socket messages.
    const msg = decodeClient(encode(sent), listAdapter);
    if (!msg) throw new Error(`The room would refuse a client message: ${encode(sent)}`);
    this.dispatch(this.room.receive(id, msg));
    return true;
  }

  deliverToClient(i: number): boolean {
    const msg = this.toClient[i]!.shift();
    if (!msg) return false;
    this.clients[i]!.receive(msg);
    return true;
  }

  drain(): void {
    for (let guard = 0; guard < 100_000; guard++) {
      let moved = false;
      for (let i = 0; i < this.clients.length; i++) moved = this.deliverToRoom(i) || this.deliverToClient(i) || moved;
      if (!moved) return;
    }
    throw new Error('network did not settle');
  }

  /** An op the server makes, sent to everyone like the room would. */
  commitServer(op: ListOp): ReturnType<RoomCore<ListState, ListOp, string[], Cursor>['commitServer']> {
    const result = this.room.commitServer(op);
    this.dispatch(result.out);
    return result;
  }

  private dispatch(out: Outgoing<ListOp, string[], Cursor>[]): void {
    for (const o of out) {
      this.connection.forEach((id, i) => {
        if (!id) return;
        const target = o.to === null ? id !== o.except && this.room.isReady(id) : id === o.to;
        if (target) this.toClient[i]!.push(o.msg);
      });
    }
  }
}

describe('framing', () => {
  it('splits long messages into frames and joins them again', () => {
    const text = JSON.stringify({ type: 'resync', revision: 1, snapshot: { s: 'x"\\'.repeat(5000) + '\u{1F600}'.repeat(100) } });
    const frames = toFrames(text, 'm1', 1000);
    expect(frames.length).toBeGreaterThan(10);
    const assembler = new FrameAssembler();
    const joined = frames.map((f) => assembler.accept(f));
    expect(joined.slice(0, -1).every((j) => j === null)).toBe(true);
    expect(joined.at(-1)).toBe(text);
    expect(toFrames('{"type":"ping"}', 'm2', 1000)).toEqual(['{"type":"ping"}']);
    expect(assembler.accept('{"type":"ping"}')).toBe('{"type":"ping"}');
    expect(new FrameAssembler(4).accept(frames[0]!)).toBeNull();
  });
});

describe('decoding', () => {
  it('checks ops and presence with the adapter, and finds the batch id of a refused submit', () => {
    expect(decodeClient('{"type":"hello","revision":null}', listAdapter)).toEqual({ type: 'hello', revision: null });
    const bad = JSON.stringify({ type: 'submit', batchId: 'x:1', baseRevision: 0, op: { type: 'ins', at: 'one' } });
    expect(decodeClient(bad, listAdapter)).toBeNull();
    expect(refusedBatchId(bad)).toBe('x:1');
    expect(decodeClient('{"type":"presence","presence":{"index":2}}', listAdapter)).not.toBeNull();
    expect(decodeClient('{"type":"presence","presence":{"row":2}}', listAdapter)).toBeNull();
    expect(decodeClient('{"type":"nope"}', listAdapter)).toBeNull();
    expect(decodeClient('not json', listAdapter)).toBeNull();
  });
});

describe('co-editing a toy document', () => {
  it('loads every client and orders concurrent edits the same everywhere', () => {
    const net = new Network(2);
    net.drain();
    net.clients[0]!.apply({ type: 'ins', at: 0, item: 'x' });
    net.clients[1]!.apply({ type: 'del', at: 0 });
    net.clients[1]!.apply({ type: 'ins', at: 0, item: 'y' });
    net.drain();
    expect(net.room.state.items).toEqual(['x', 'y', 'b', 'c']);
    for (const c of net.clients) expect(c.state!.items).toEqual(net.room.state.items);
    // Client 1's second edit waited for the first batch's ack, so it went as a batch of its own.
    expect(net.room.revision).toBe(3);
  });

  it('keeps viewers from changing the document and rolls their edits back', () => {
    const net = new Network(2, [1]);
    net.drain();
    expect(net.clients[1]!.canEdit).toBe(false);
    net.clients[1]!.apply({ type: 'del', at: 0 });
    net.drain();
    expect(net.room.state.items).toEqual(['a', 'b', 'c']);
    expect(net.clients[1]!.state!.items).toEqual(['a', 'b', 'c']);
    expect(net.clients[1]!.hasPending).toBe(false);
  });

  it('lets a commenter commit only what mayComment accepts, against the transformed op', () => {
    // A "comment" here is an item starting with '#', and only at the end.
    const seen: ListOp[] = [];
    const mayComment = (op: ListOp, peer: { userId: string }, state: ListState) => {
      seen.push(op);
      return peer.userId === 'u_c' && flatten(op).every((o) => o.type === 'ins' && o.item.startsWith('#') && o.at === state.items.length);
    };
    const room = new RoomCore(listAdapter, ['a'], 0, { mayComment });
    room.join({ clientId: 'e', userId: 'u_e', name: 'E', color: '#000', canEdit: true });
    room.join({ clientId: 'c', userId: 'u_c', name: 'C', color: '#000', canEdit: false, canComment: true });
    room.join({ clientId: 'v', userId: 'u_v', name: 'V', color: '#000', canEdit: false });
    for (const id of ['e', 'c', 'v']) room.receive(id, { type: 'hello', revision: null });
    room.receive('e', { type: 'submit', batchId: 'e:1', baseRevision: 0, op: { type: 'ins', at: 0, item: 'z' } });

    const submit = (id: string, batchId: string, op: ListOp) =>
      room.receive(id, { type: 'submit', batchId, baseRevision: 0, op }).map((o) => o.msg)[0];
    // Made at the end of ['a'], transformed past the editor's insert to the end of ['z', 'a'].
    expect(submit('c', 'c:1', { type: 'ins', at: 1, item: '#note' })).toEqual({ type: 'ack', batchId: 'c:1', revision: 2 });
    expect(seen[0]).toEqual({ type: 'ins', at: 2, item: '#note' });
    expect(submit('c', 'c:2', { type: 'del', at: 0 })).toEqual({ type: 'reject', batchId: 'c:2', reason: 'read-only' });
    // A viewer (no canComment) is never asked about.
    expect(submit('v', 'v:1', { type: 'ins', at: 1, item: '#note' })).toEqual({ type: 'reject', batchId: 'v:1', reason: 'read-only' });
    expect(seen).toHaveLength(2);
    expect(room.state.items).toEqual(['z', 'a', '#note']);

    // Without the option, a commenter is a viewer.
    const plain = new RoomCore(listAdapter, ['a'], 0);
    plain.join({ clientId: 'c', userId: 'u_c', name: 'C', color: '#000', canEdit: false, canComment: true });
    plain.receive('c', { type: 'hello', revision: null });
    const [out] = plain.receive('c', { type: 'submit', batchId: 'c:1', baseRevision: 0, op: { type: 'ins', at: 1, item: '#x' } });
    expect(out!.msg).toEqual({ type: 'reject', batchId: 'c:1', reason: 'read-only' });
  });

  it('starts a client over from a restored document', () => {
    const restored: { versionId: string; userId: string; revision: number }[] = [];
    const resets: boolean[] = [];
    const client = new CollabClient(listAdapter, {
      send: () => undefined,
      sessionId: 's',
      onReset: (_state, info) => resets.push(info.lostEdits),
      onRestored: (info) => restored.push(info),
    });
    client.receive({ type: 'welcome', clientId: 'x', revision: 4, peers: [], canEdit: true, snapshot: ['a', 'b'] });
    client.apply({ type: 'ins', at: 0, item: 'unsent' });
    const msg: ServerMessage<ListOp, string[], Cursor> = { type: 'restored', revision: 5, snapshot: ['old'], versionId: 'v1', userId: 'u2' };
    // Passes the client-side decoder like any server message.
    expect(decodeServer(encode(msg))).toEqual(msg);
    client.receive(msg);
    expect(client.state!.items).toEqual(['old']);
    expect(client.revision).toBe(5);
    expect(client.hasPending).toBe(false);
    expect(resets).toEqual([false, true]);
    expect(restored).toEqual([{ versionId: 'v1', userId: 'u2', revision: 5 }]);
  });

  it('commits an op the server makes, and clients with edits in flight still converge', () => {
    const committed: number[] = [];
    const net = new Network(2, [], (c) => committed.push(c.revision));
    net.drain();
    // Client 0 edits; the server writes before the room has seen it.
    net.clients[0]!.apply({ type: 'ins', at: 1, item: 'x' });
    const result = net.commitServer({ type: 'ins', at: 0, item: 'srv' });
    expect(result.committed).toMatchObject({ revision: 1, clientId: 'server' });
    expect(net.commitServer({ type: 'del', at: 99 })).toMatchObject({ committed: null, refused: 'out of range' });
    net.drain();
    expect(net.room.state.items).toEqual(['srv', 'a', 'x', 'b', 'c']);
    for (const c of net.clients) expect(c.state!.items).toEqual(net.room.state.items);
    expect(committed).toEqual([1, 2]);
  });

  it('undoes a batch that fails halfway and asks to be rebuilt', () => {
    // Validation that lets everything through, so the bad delete reaches apply.
    const failing: OtAdapter<ListState, ListOp, string[], Cursor> = { ...listAdapter, validate: () => null };
    const room = new RoomCore(failing, ['a'], 0);
    room.join({ clientId: 'c', userId: 'u', name: 'U', color: '#000', canEdit: true });
    room.receive('c', { type: 'hello', revision: null });
    const op: ListOp = { type: 'batch', ops: [{ type: 'ins', at: 0, item: 'z' }, { type: 'del', at: 9 }] };
    expect(room.receive('c', { type: 'submit', batchId: 'x:1', baseRevision: 0, op }).map((o) => o.msg)).toEqual([
      { type: 'reject', batchId: 'x:1', reason: 'invalid' },
    ]);
    expect(room.state.items).toEqual(['a']);
    expect(room.needsReload).toBe(true);
  });

  it('restores a room from a checkpoint and its op log', () => {
    const committed: CommittedOp<ListOp>[] = [];
    const room = new RoomCore(listAdapter, [], 0, { onCommit: (c) => committed.push(c) });
    room.join({ clientId: 'a', userId: 'u', name: 'U', color: '#000', canEdit: true });
    room.receive('a', { type: 'hello', revision: null });
    let checkpoint: string[] = [];
    for (let i = 0; i < 5; i++) {
      room.receive('a', { type: 'submit', batchId: `b${i}`, baseRevision: i, op: { type: 'ins', at: i, item: `i${i}` } });
      if (room.revision === 3) checkpoint = listAdapter.snapshot(room.state);
    }
    const restored = RoomCore.restore(listAdapter, checkpoint, 3, committed);
    expect(restored.revision).toBe(5);
    expect(restored.state.items).toEqual(room.state.items);
    restored.join({ clientId: 'b', userId: 'u', name: 'U', color: '#000', canEdit: true });
    const [welcome] = restored.receive('b', { type: 'hello', revision: 1 });
    expect(welcome!.msg.type === 'welcome' && welcome!.msg.catchUp?.map((c) => c.revision)).toEqual([2, 3, 4, 5]);
    expect(() => RoomCore.restore(listAdapter, checkpoint, 3, committed.slice(4))).toThrow(/gap/);
  });

  it('converges under random edits, delays and reconnects', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const net = new Network(3);
    for (let step = 0; step < 3000; step++) {
      const i = rand(net.clients.length);
      const c = net.clients[i]!;
      const action = rand(20);
      if (action < 7) {
        const items = c.state?.items;
        if (!net.connected(i) || !items) continue;
        c.apply(items.length && rand(3) === 0 ? { type: 'del', at: rand(items.length) } : { type: 'ins', at: rand(items.length + 1), item: `${i}.${step}` });
      } else if (action < 13) {
        net.deliverToRoom(i);
      } else if (action < 19) {
        net.deliverToClient(i);
      } else if (net.connected(i)) {
        net.disconnect(i);
      } else {
        net.connect(i);
      }
    }
    for (let i = 0; i < net.clients.length; i++) if (!net.connected(i)) net.connect(i);
    net.drain();
    for (const c of net.clients) {
      expect(c.hasPending).toBe(false);
      expect(c.revision).toBe(net.room.revision);
      expect(c.state!.items).toEqual(net.room.state.items);
    }
    expect(net.room.revision).toBeGreaterThan(150);
  });
});
