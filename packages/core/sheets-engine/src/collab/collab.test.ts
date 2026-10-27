import { describe, expect, it, vi } from 'vitest';
import { MAX_COLS } from '../address';
import { Sheet, Workbook, type WorkbookSnapshot } from '../model/workbook';
import type { Op } from '../ops/types';
import { CollabClient } from './client';
import { decodeClient, encode, type ClientMessage, type CommittedOp, type ServerMessage } from './protocol';
import { RoomCore, type Outgoing } from './room';

const ENGINE = { now: () => 0, random: () => 0.5, timezoneOffset: () => 0 };

function baseSnapshot(): WorkbookSnapshot {
  const wb = new Workbook();
  wb.sheets.push(new Sheet('s1', 'Sheet1'));
  return wb.toJSON();
}

/** A room and clients joined by FIFO queues whose delivery the test controls. */
class Network {
  readonly room: RoomCore;
  readonly clients: CollabClient[] = [];
  private readonly connection: (string | null)[] = [];
  private readonly toRoom: ClientMessage[][] = [];
  private readonly toClient: ServerMessage[][] = [];
  private connections = 0;
  rejects = 0;

  constructor(count: number, readOnly: number[] = []) {
    this.room = new RoomCore(baseSnapshot(), 0, { engine: ENGINE, maxLog: 50 });
    for (let i = 0; i < count; i++) {
      this.toRoom.push([]);
      this.toClient.push([]);
      this.connection.push(null);
      this.clients.push(
        new CollabClient({
          send: (msg) => this.toRoom[i]!.push(msg),
          engine: ENGINE,
          sessionId: `client${i}`,
        }),
      );
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
    // Through JSON and the same checks the Durable Object applies to socket messages.
    const msg = decodeClient(encode(sent));
    if (!msg) throw new Error(`The room would refuse a client message: ${encode(sent)}`);
    this.dispatch(this.room.receive(id, msg));
    return true;
  }

  deliverToClient(i: number): boolean {
    const msg = this.toClient[i]!.shift();
    if (!msg) return false;
    if (msg.type === 'reject') this.rejects++;
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

  private dispatch(out: Outgoing[]): void {
    for (const o of out) {
      this.connection.forEach((id, i) => {
        if (!id) return;
        const target = o.to === null ? id !== o.except && this.room.isReady(id) : id === o.to;
        if (target) this.toClient[i]!.push(o.msg);
      });
    }
  }
}

const value = (c: CollabClient, row: number, col: number) => c.engine!.getValue('s1', row, col);

describe('co-editing', () => {
  it('loads every client and shares edits', () => {
    const net = new Network(2);
    net.drain();
    net.clients[0]!.apply({ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 5 }]] });
    net.clients[1]!.apply({ type: 'setCells', sheetId: 's1', cells: [[1, 0, { f: 'A1*2' }]] });
    net.drain();
    for (const c of net.clients) {
      expect(value(c, 0, 0)).toBe(5);
      expect(value(c, 1, 0)).toBe(10);
    }
    expect(net.room.revision).toBe(2);
  });

  it('rebases a pending edit over a concurrent row insert', () => {
    const net = new Network(2);
    net.drain();
    net.clients[0]!.apply({ type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 0, count: 2 });
    net.clients[1]!.apply({ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 'mine' }]] });
    net.drain();
    for (const c of net.clients) expect(value(c, 2, 0)).toBe('mine');
  });

  it('does not apply a batch twice when its ack was lost in a reconnect', () => {
    const net = new Network(1);
    net.drain();
    net.clients[0]!.apply({ type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 0, count: 1 });
    net.deliverToRoom(0); // committed, but the ack never arrives
    net.disconnect(0);
    net.connect(0);
    net.drain();
    expect(net.room.revision).toBe(1);
    expect(net.clients[0]!.revision).toBe(1);
    expect(net.clients[0]!.hasPending).toBe(false);
  });

  it('keeps viewers from changing the workbook', () => {
    const net = new Network(2, [1]);
    net.drain();
    expect(net.clients[1]!.canEdit).toBe(false);
    net.clients[1]!.apply({ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 'nope' }]] });
    net.drain();
    expect(net.room.engine.getValue('s1', 0, 0)).toBeNull();
    expect(value(net.clients[1]!, 0, 0)).toBeNull();
    expect(net.rejects).toBe(1);
  });

  it('refuses a garbled batch without touching the workbook', () => {
    const net = new Network(1);
    net.drain();
    const garbled = { type: 'batch', ops: [{ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 1 }]] }, { type: 'setNames', names: null }] };
    expect(decodeClient(JSON.stringify({ type: 'submit', batchId: 'x:1', baseRevision: 0, op: garbled }))).toBeNull();
    const out = net.room.receive('conn1', { type: 'submit', batchId: 'x:1', baseRevision: 0, op: garbled as never });
    expect(out.map((o) => o.msg.type)).toEqual(['reject', 'resync']);
    expect(net.room.engine.getValue('s1', 0, 0)).toBeNull();
    expect(net.room.revision).toBe(0);
  });

  it('undoes a batch whose op throws, rejects it and asks to be rebuilt', () => {
    const net = new Network(1);
    net.drain();
    vi.spyOn(net.room.engine, 'setNames').mockImplementation(() => {
      throw new Error('engine bug');
    });
    const op = { type: 'batch', ops: [{ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 1 }]] }, { type: 'setNames', names: [] }] } as const;
    const out = net.room.receive('conn1', { type: 'submit', batchId: 'x:1', baseRevision: 0, op: op as never });
    expect(out.map((o) => o.msg)).toEqual([{ type: 'reject', batchId: 'x:1', reason: 'invalid' }]);
    expect(net.room.engine.getValue('s1', 0, 0)).toBeNull();
    expect(net.room.needsReload).toBe(true);
    expect(net.room.receive('conn1', { type: 'submit', batchId: 'x:2', baseRevision: 0, op: { type: 'setCells', sheetId: 's1', cells: [] } })).toEqual([]);
  });

  it('takes back its unconfirmed edits when the room refuses its batch', () => {
    const net = new Network(2);
    net.drain();
    const [a, b] = net.clients;
    a!.apply({ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 1 }]] });
    net.drain();
    const reset = vi.fn();
    (a as unknown as { options: { onReset: typeof reset } }).options.onReset = reset;
    a!.apply({ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 2 }]] });
    a!.apply({ type: 'setCells', sheetId: 's1', cells: [[1, 0, { v: 3 }]] });
    a!.receive({ type: 'reject', batchId: 'client0:2', reason: 'invalid' });
    expect(a!.hasPending).toBe(false);
    expect([value(a!, 0, 0), value(a!, 1, 0)]).toEqual([1, null]);
    expect(reset).toHaveBeenCalledWith(a!.engine, { canEdit: true, lostEdits: true });
    expect(JSON.stringify(a!.engine!.toSnapshot())).toBe(JSON.stringify(b!.engine!.toSnapshot()));

    // The resync the room sends after a reject does not report the same lost edits again.
    a!.receive({ type: 'resync', revision: net.room.revision, snapshot: net.room.engine.toSnapshot() });
    expect(reset.mock.calls.map(([, info]) => info.lostEdits)).toEqual([true, false]);
  });

  it('restores a room from a checkpoint and its op log', () => {
    // The op log as a Durable Object keeps it: revisions 1–5, checkpointed at 3.
    const committed: CommittedOp[] = [];
    const room = new RoomCore(baseSnapshot(), 0, { engine: ENGINE, onCommit: (c) => committed.push(c) });
    room.join({ clientId: 'a', userId: 'u', name: 'U', color: '#000', canEdit: true });
    room.receive('a', { type: 'hello', revision: null });
    let checkpoint: WorkbookSnapshot = baseSnapshot();
    for (let i = 0; i < 5; i++) {
      room.receive('a', { type: 'submit', batchId: `b${i}`, baseRevision: i, op: { type: 'setCells', sheetId: 's1', cells: [[i, 0, { v: i + 1 }]] } });
      if (room.revision === 3) checkpoint = room.engine.toSnapshot();
    }
    const restored = RoomCore.restore(checkpoint, 3, committed, { engine: ENGINE });
    expect(restored.revision).toBe(5);
    expect(JSON.stringify(restored.engine.toSnapshot())).toBe(JSON.stringify(room.engine.toSnapshot()));
    // A client at revision 1 still catches up from the log.
    restored.join({ clientId: 'b', userId: 'u', name: 'U', color: '#000', canEdit: true });
    const [welcome] = restored.receive('b', { type: 'hello', revision: 1 });
    expect(welcome!.msg.type === 'welcome' && welcome!.msg.catchUp?.map((c) => c.revision)).toEqual([2, 3, 4, 5]);
    expect(() => RoomCore.restore(checkpoint, 3, committed.slice(4), { engine: ENGINE })).toThrow(/gap/);
  });

  it('converges under random edits, delays and reconnects', () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const net = new Network(4);
    let sheetCounter = 0;
    const randomOp = (c: CollabClient): Op => {
      const sheets = c.engine!.workbook.sheets;
      const sheet = sheets[rand(sheets.length)]!;
      const sheetId = sheet.id;
      const axis = rand(2) ? 'row' : 'col';
      const r = rand(12);
      const col = rand(6);
      switch (rand(19)) {
        case 17: {
          const id = `cm${rand(3)}`;
          const root = rand(2) === 0;
          return rand(5)
            ? { type: 'patchComments', sheetId, set: [{ id: root ? id : `${id}r${rand(3)}`, authorId: `u${rand(2)}`, createdAt: 1, ...(root ? { cell: { row: r, col }, resolved: !!rand(2) } : {}) }] }
            : { type: 'patchComments', sheetId, remove: [id] };
        }
        case 18:
          return { type: 'patchDataTables', sheetId, set: [{ id: `dt${rand(2)}`, range: { r1: r, c1: col, r2: r + rand(4), c2: col + rand(3) } }], remove: rand(5) ? [] : [`dt${rand(2)}`] };
        case 15:
          return { type: 'patchCharts', sheetId, set: [{ id: `ch${rand(2)}`, type: rand(2) ? 'column' : 'line', categories: `$A$1:$A$${2 + rand(8)}`, series: [{ name: '$B$1', values: `$B$2:$B$${2 + rand(8)}` }], anchor: { row: r, col, dx: rand(20), dy: 0 }, width: 300, height: 200 }], remove: rand(5) ? [] : [`ch${rand(2)}`] };
        case 16:
          return { type: 'setCells', sheetId, cells: [[r, col + 4, { f: 'PIVOT($A$1:$C$8,"Region","","SUM:Amount")' }]] };
        case 12:
          return rand(3)
            ? { type: 'setFilter', sheetId, filter: { range: { r1: rand(3), c1: 0, r2: 10, c2: 3 }, columns: [{ col: rand(3), condition: { type: 'greater', value: rand(50) } }, { col: 0, hiddenValues: [`n:${rand(100)}`] }] } }
            : { type: 'setFilter', sheetId, filter: null };
        case 13:
          return { type: 'patchConditionalFormats', sheetId, set: [{ id: `cf${rand(3)}`, order: rand(5), ranges: [{ r1: r, c1: col, r2: r + 2, c2: col + 1 }], rule: { type: 'condition', condition: { type: 'formula', formula: `A${r + 1}>${rand(50)}` }, style: { bold: true } } }], remove: rand(4) ? [] : [`cf${rand(3)}`] };
        case 14:
          return { type: 'patchValidations', sheetId, set: [{ id: `dv${rand(3)}`, ranges: [{ r1: r, c1: col, r2: r + 3, c2: col }], criteria: { type: 'listRange', source: `$B$1:$B${1 + rand(9)}` }, strict: !!rand(2) }] };
        case 0:
          return { type: 'insertDims', sheetId, sheetName: sheet.name, axis, at: rand(10), count: 1 + rand(2) };
        case 1:
          return { type: 'deleteDims', sheetId, sheetName: sheet.name, axis, at: rand(10), count: 1 + rand(2) };
        case 2:
          return { type: 'moveDims', sheetId, sheetName: sheet.name, axis, from: rand(4), count: 1, to: 6 + rand(3) };
        case 3:
          return { type: 'formatRanges', sheetId, ranges: [{ r1: r, c1: col, r2: r + rand(3), c2: col + rand(2) }], patch: { bold: rand(2) ? true : null } };
        case 4:
          return { type: 'formatRanges', sheetId, ranges: [{ r1: r, c1: 0, r2: r, c2: MAX_COLS - 1 }], patch: { fill: '#eeeeee' } };
        case 5:
          return { type: 'merge', sheetId, ranges: [{ r1: r, c1: col, r2: r + 1, c2: col + 1 }] };
        case 6:
          return { type: 'unmerge', sheetId, ranges: [{ r1: r, c1: col, r2: r + 2, c2: col + 2 }] };
        case 7:
          return sheets.length > 1 && rand(3) === 0
            ? { type: 'deleteSheet', sheetId, sheetName: sheet.name }
            : { type: 'addSheet', sheetId: `x${++sheetCounter}`, name: `Extra ${sheetCounter}`, index: rand(sheets.length + 1) };
        case 8:
          return { type: 'patchNames', set: [{ name: rand(2) ? 'total' : 'rate', formula: `Sheet1!A${1 + rand(9)}` }] };
        default:
          return {
            type: 'setCells',
            sheetId,
            cells: [
              [r, col, rand(3) ? { v: rand(100) } : { f: `A${1 + rand(9)}+1` }],
              [rand(12), rand(6), null],
            ],
          };
      }
    };

    for (let step = 0; step < 4000; step++) {
      const i = rand(net.clients.length);
      const c = net.clients[i]!;
      const action = rand(20);
      if (action < 7) {
        if (net.connected(i) && c.engine) c.apply(randomOp(c));
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

    const expected = JSON.stringify(net.room.engine.toSnapshot());
    for (const c of net.clients) {
      expect(c.hasPending).toBe(false);
      expect(c.revision).toBe(net.room.revision);
      expect(JSON.stringify(c.engine!.toSnapshot())).toBe(expected);
    }
    expect(net.room.revision).toBeGreaterThan(300);
  });
});
