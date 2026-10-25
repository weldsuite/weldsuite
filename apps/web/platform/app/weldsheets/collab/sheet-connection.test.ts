import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import {
  EN_LOCALE,
  FrameAssembler,
  RoomCore,
  Sheet,
  Workbook,
  decodeClient,
  encode,
  toFrames,
  type Outgoing,
} from '@weldsuite/sheets-engine';
import { SheetController } from '../editor/model/sheet-controller';
import { SheetConnection } from './sheet-connection';

const TAB = 'sh_tab';

/** A RoomCore behind fake sockets; frames are queued until `pump()` delivers them. */
class RoomServer {
  readonly room: RoomCore;
  readonly sockets = new Map<string, FakeSocket>();
  private readonly queue: (() => void)[] = [];
  private nextId = 0;

  constructor() {
    const workbook = new Workbook();
    workbook.sheets.push(new Sheet(TAB, 'Sheet1'));
    this.room = new RoomCore(workbook.toJSON(), 0);
  }

  connect(socket: FakeSocket, canEdit = true): void {
    const clientId = `c${++this.nextId}`;
    socket.clientId = clientId;
    this.sockets.set(clientId, socket);
    this.room.join({ clientId, userId: `u${this.nextId}`, name: 'U', color: '#000', canEdit });
    const assembler = new FrameAssembler();
    socket.toServer = (frame) =>
      this.queue.push(() => {
        const text = assembler.accept(frame);
        const msg = text === null ? null : decodeClient(text);
        if (msg && this.sockets.has(clientId)) this.dispatch(this.room.receive(clientId, msg));
      });
    this.queue.push(() => socket.open());
  }

  disconnect(socket: FakeSocket): void {
    this.sockets.delete(socket.clientId);
    this.dispatch(this.room.leave(socket.clientId));
    socket.drop();
  }

  pump(): void {
    for (let guard = 0; guard < 10_000 && this.queue.length > 0; guard++) this.queue.shift()!();
  }

  private dispatch(out: Outgoing[]): void {
    for (const o of out) {
      // Small frames, so the platform's framing is exercised too.
      const frames = toFrames(encode(o.msg), `s${Math.random()}`, 200);
      for (const [id, socket] of this.sockets) {
        const target = o.to === null ? id !== o.except && this.room.isReady(id) : id === o.to;
        if (target) for (const frame of frames) this.queue.push(() => socket.deliver(frame));
      }
    }
  }
}

class FakeSocket {
  static readonly OPEN = 1;
  static server: RoomServer;
  static canEdit = true;
  readyState = 0;
  clientId = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  toServer: (frame: string) => void = () => {};

  constructor(readonly url: string) {
    FakeSocket.server.connect(this, FakeSocket.canEdit);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  send(frame: string): void {
    this.toServer(frame);
  }

  deliver(frame: string): void {
    if (this.readyState === FakeSocket.OPEN) this.onmessage?.({ data: frame });
  }

  /** The connection is lost (what the client sees). */
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  close(): void {
    if (this.readyState === 3) return;
    FakeSocket.server.disconnect(this);
  }
}

/** A connection with a controller on top, wired the way LiveSheet wires them. */
function openSheet(openSession: () => Promise<string> = async () => 'ws://room') {
  const state: { controller: SheetController | null; gone: boolean } = { controller: null, gone: false };
  const connection: SheetConnection = new SheetConnection({
    openSession,
    events: {
      onReset: (engine) => {
        if (state.controller) state.controller.replaceEngine(engine);
        else state.controller = new SheetController(engine, { locale: EN_LOCALE, formulaLocale: { decimal: '.' }, applyOp: (op) => connection.apply(op) });
      },
      onRemoteOp: (op) => state.controller?.remoteOp(op),
      onPeers: (peers) => state.controller?.setPeers(peers),
      onStatus: () => {},
      onGone: () => (state.gone = true),
    },
  });
  connection.start();
  return { connection, state, ctl: () => state.controller! };
}

let server: RoomServer;

/** Lets the session promise settle, then delivers everything queued. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  server.pump();
  await vi.advanceTimersByTimeAsync(0);
  server.pump();
}

beforeEach(() => {
  vi.useFakeTimers();
  server = new RoomServer();
  FakeSocket.server = server;
  FakeSocket.canEdit = true;
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SheetConnection', () => {
  it('loads the sheet and shares edits both ways', async () => {
    const a = openSheet();
    const b = openSheet();
    await settle();
    a.ctl().setInput(0, 0, '5');
    b.ctl().setInput(1, 0, '=A1*2');
    expect(a.connection.pending).toBe(true);
    await settle();
    for (const s of [a, b]) {
      expect(s.ctl().engine.getValue(TAB, 0, 0)).toBe(5);
      expect(s.ctl().engine.getValue(TAB, 1, 0)).toBe(10);
      expect(s.connection.pending).toBe(false);
    }
    expect(server.room.revision).toBe(2);
  });

  it('undoes a change where it moved to after someone inserted rows above it', async () => {
    const a = openSheet();
    const b = openSheet();
    await settle();
    a.ctl().setInput(0, 0, 'mine');
    await settle();
    b.ctl().apply({ type: 'insertDims', sheetId: TAB, sheetName: 'Sheet1', axis: 'row', at: 0, count: 2 });
    await settle();
    expect(a.ctl().engine.getValue(TAB, 2, 0)).toBe('mine');
    a.ctl().undo();
    await settle();
    for (const s of [a, b]) {
      expect(s.ctl().engine.getValue(TAB, 2, 0)).toBeNull();
      expect(s.ctl().sheet.rowCount).toBe(a.ctl().sheet.rowCount);
    }
  });

  it('re-sends unconfirmed edits after reconnecting', async () => {
    const a = openSheet();
    const b = openSheet();
    await settle();
    const socket = [...server.sockets.values()][0]!;
    a.ctl().setInput(3, 3, '42');
    server.disconnect(socket); // lost before the room saw the edit
    expect(a.connection.status).toBe('reconnecting');
    expect(a.connection.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(a.connection.status).toBe('open');
    expect(a.connection.pending).toBe(false);
    expect(b.ctl().engine.getValue(TAB, 3, 3)).toBe(42);
  });

  it('shows where everyone is, also after a reconnect', async () => {
    const a = openSheet();
    const b = openSheet();
    await settle();
    a.connection.setPresence({ sheetId: TAB, active: { row: 2, col: 3 }, ranges: [{ r1: 2, c1: 3, r2: 4, c2: 3 }] });
    await settle();
    expect(b.ctl().peers.map((p) => p.presence?.active)).toEqual([{ row: 2, col: 3 }]);

    server.disconnect([...server.sockets.values()][0]!);
    server.pump();
    expect(b.ctl().peers).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(b.ctl().peers.map((p) => p.presence?.active)).toEqual([{ row: 2, col: 3 }]);
  });

  it('gives up when the sheet is gone', async () => {
    const s = openSheet(async () => {
      throw new ApiError('Not found', 404);
    });
    await settle();
    expect(s.state.gone).toBe(true);
    expect(s.connection.status).toBe('closed');
  });

  it('opens read-only for viewers', async () => {
    FakeSocket.canEdit = false;
    const s = openSheet();
    await settle();
    expect(s.connection.client.canEdit).toBe(false);
  });
});
