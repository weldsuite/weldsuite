/**
 * SheetRoom — one Durable Object per spreadsheet (named `${workspaceId}:${sheetId}`),
 * the single place a sheet's edits are ordered (ADR SHEETS-003).
 *
 * The co-editing logic is `RoomCore` from @weldsuite/sheets-engine; this
 * class gives it sockets and persistence:
 *
 *   - Admission: the session route checks access, then calls `admit()` (RPC)
 *     for a single-use ticket; the browser opens the socket with it.
 *   - Sockets use the hibernation API. Each socket's attachment carries its
 *     peer, so a room that wakes up re-admits the people still connected.
 *   - Every committed op is written to this object's storage before the ack
 *     can leave (the output gate holds sends until writes are durable).
 *   - Checkpoints: the whole workbook goes to R2 (one object per sheet) every
 *     CHECKPOINT_EVERY ops, CHECKPOINT_DELAY_MS after an edit, and when the
 *     last person leaves. Ops older than the checkpoint are trimmed, except
 *     the last KEEP_LOG for clients catching up. The tenant DB row then
 *     records the new revision and an entity event reports the change.
 *   - Messages longer than a frame go as parts (`toFrames`/`FrameAssembler`).
 */

import { DurableObject } from 'cloudflare:workers';
import {
  EN_LOCALE,
  FrameAssembler,
  NL_LOCALE,
  RoomCore,
  Sheet,
  Workbook,
  decodeClient,
  refusedBatchId,
  encode,
  toFrames,
  writeCsv,
  writeXlsx,
  type CommittedOp,
  type Op,
  type Outgoing,
  type Peer,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { recordCheckpoint } from '../services/sheets';
import { readSnapshot, writeSnapshot } from './snapshot';

/** What the session route tells the room: which sheet it is, and who is coming in. */
export interface Admission {
  /** Clerk org id (what worker-kit calls the workspace id). */
  workspaceId: string;
  sheetId: string;
  snapshotKey: string;
  userId: string;
  name: string;
  picture: string | null;
  color: string;
  canEdit: boolean;
}

/** Which sheet a room holds, and where its checkpoint is. */
export interface RoomMeta {
  workspaceId: string;
  sheetId: string;
  snapshotKey: string;
}

export interface ExportRequest {
  format: 'xlsx' | 'csv';
  /** The tab a CSV holds; default the first visible one. */
  tab?: string;
  locale?: 'en' | 'nl';
}

export interface ExportedFile {
  bytes: Uint8Array;
  /** The tab a CSV holds, for its file name. */
  tabName: string | null;
}

interface Ticket {
  peer: Omit<Peer, 'clientId'>;
  expires: number;
}

/** Kept on each socket, so it survives hibernation. */
interface SocketState {
  peer: Peer;
  /** Said hello, so receives broadcasts. */
  ready: boolean;
}

/** A logged op. Ops too big for one storage value keep their JSON in `parts` extra keys. */
interface StoredOp {
  revision: number;
  batchId: string;
  clientId: string;
  op?: Op;
  parts?: number;
}

const TICKET_TTL_MS = 60_000;
const CHECKPOINT_EVERY = 200;
const CHECKPOINT_DELAY_MS = 30_000;
const KEEP_LOG = 500;
/** Characters per stored part; SQLite-backed objects take values up to 2 MiB. */
const OP_PART = 1_000_000;
const OP_PREFIX = 'op:';
const TICKET_PREFIX = 'ticket:';
/** Sheet id of the workbook a room starts from when its sheet has no checkpoint at all. */
const FALLBACK_SHEET_ID = 'sheet1';

export class SheetRoom extends DurableObject<Env> {
  private room: RoomCore | null = null;
  private loading: Promise<RoomCore> | null = null;
  private meta: RoomMeta | null = null;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly assemblers = new Map<string, FrameAssembler>();
  /** Revision of the latest checkpoint in R2. */
  private checkpointed = 0;
  private checkpointing: Promise<void> | null = null;
  private alarmPending = false;
  private frameCounter = 0;

  /** Registers a ticket for one connection (RPC from the session route). */
  async admit(admission: Admission): Promise<string> {
    const { workspaceId, sheetId, snapshotKey, ...peer } = admission;
    this.meta ??= { workspaceId, sheetId, snapshotKey };
    const secret = randomToken();
    const now = Date.now();
    const expired = [...(await this.ctx.storage.list<Ticket>({ prefix: TICKET_PREFIX })).entries()]
      .filter(([, ticket]) => ticket.expires < now)
      .map(([key]) => key);
    if (expired.length > 0) await this.ctx.storage.delete(expired.slice(0, 128));
    await this.ctx.storage.put<unknown>({
      meta: { workspaceId, sheetId, snapshotKey },
      [`${TICKET_PREFIX}${secret}`]: { peer, expires: now + TICKET_TTL_MS } satisfies Ticket,
    });
    return `${this.ctx.id.toString()}.${secret}`;
  }

  /**
   * The workbook as a file, written from the room's live state, edits not
   * yet checkpointed included (RPC from the export route). Null when the CSV's
   * tab does not exist.
   */
  async exportFile(sheet: RoomMeta, request: ExportRequest): Promise<ExportedFile | null> {
    if (!this.meta) {
      this.meta = sheet;
      await this.ctx.storage.put('meta', sheet);
    }
    const { engine } = this.room ?? (await this.load());
    const locale = request.locale === 'nl' ? NL_LOCALE : EN_LOCALE;
    if (request.format === 'xlsx') return { bytes: await writeXlsx(engine, { locale }), tabName: null };
    const sheets = engine.workbook.sheets;
    const tab = request.tab ? engine.workbook.getSheet(request.tab) : (sheets.find((s) => !s.props.hidden) ?? sheets[0]);
    if (!tab) return null;
    // A byte-order mark, so Excel reads the CSV as UTF-8.
    return { bytes: new TextEncoder().encode(`\uFEFF${writeCsv(engine, tab.id, { locale })}`), tabName: tab.name };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const secret = new URL(request.url).searchParams.get('ticket')?.split('.')[1] ?? null;
    const outcome = await this.accept(pair[1], secret);
    if (outcome === 'invalid') return new Response('Invalid or expired ticket', { status: 401 });
    if (outcome === 'unavailable') return new Response('Sheet unavailable', { status: 503 });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Takes the server end of a new socket if its ticket is good (split from `fetch` for tests). */
  async accept(server: WebSocket, secret: string | null): Promise<'ok' | 'invalid' | 'unavailable'> {
    const key = `${TICKET_PREFIX}${secret ?? ''}`;
    const ticket = secret ? await this.ctx.storage.get<Ticket>(key) : undefined;
    if (!ticket || ticket.expires < Date.now()) return 'invalid';
    await this.ctx.storage.delete(key);

    let room: RoomCore;
    try {
      room = await this.load();
    } catch (err) {
      console.error('[sheets-api/room] loading the sheet failed:', err);
      return 'unavailable';
    }
    const peer: Peer = { clientId: crypto.randomUUID(), ...ticket.peer };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer, ready: false } satisfies SocketState);
    this.sockets.set(peer.clientId, server);
    room.join(peer);
    return 'ok';
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const state = socketState(ws);
    if (!state) return;
    let room: RoomCore;
    try {
      room = this.room ?? (await this.load());
    } catch (err) {
      console.error('[sheets-api/room] loading the sheet failed:', err);
      ws.close(1011, 'Sheet unavailable');
      return;
    }
    const text = this.assembler(state.peer.clientId).accept(message);
    if (text === null) return;
    const msg = decodeClient(text);
    if (!msg) {
      // Malformed: never applied. A submit still gets its answer, or the sender would wait for ever.
      const batchId = refusedBatchId(text);
      if (batchId) this.dispatch(room, room.refuse(state.peer.clientId, batchId));
      return;
    }

    const before = room.revision;
    let out: Outgoing[];
    try {
      out = room.receive(state.peer.clientId, msg);
    } catch (err) {
      console.error('[sheets-api/room] handling a message failed:', err);
      this.reload();
      return;
    }
    if (msg.type === 'hello' && !state.ready) ws.serializeAttachment({ ...state, ready: true } satisfies SocketState);
    this.dispatch(room, out);
    if (room.needsReload) {
      console.error('[sheets-api/room] an op failed to apply; rebuilding the room from its checkpoint');
      this.reload();
      return;
    }
    if (room.revision > before) this.edited(room, state.peer.userId);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = socketState(ws);
    // Complete the closing handshake, or the browser waits seconds before it
    // sees the socket closed.
    try {
      ws.close(replyCode(code), reason);
    } catch {
      // Already closed.
    }
    if (!state) return;
    this.sockets.delete(state.peer.clientId);
    this.assemblers.delete(state.peer.clientId);
    const room = this.room ?? (await this.load().catch(() => null));
    if (!room) return;
    this.dispatch(room, room.leave(state.peer.clientId));
    if (this.sockets.size === 0) await this.checkpoint().catch((err) => console.error('[sheets-api/room] checkpoint failed:', err));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  async alarm(): Promise<void> {
    this.alarmPending = false;
    if (!this.room) await this.load();
    // A failure throws, and the runtime retries the alarm.
    await this.checkpoint();
  }

  // ---- Loading ----

  /**
   * Drops the in-memory room, whose workbook may be half-changed, and closes
   * every socket. Clients reconnect and catch up from a room rebuilt from the
   * checkpoint and the log, which only hold committed ops.
   */
  private reload(): void {
    this.room = null;
    this.loading = null;
    this.sockets.clear();
    this.assemblers.clear();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1012, 'Reloading the sheet');
      } catch {
        // Already closing.
      }
    }
  }

  private load(): Promise<RoomCore> {
    this.loading ??= this.restore().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async restore(): Promise<RoomCore> {
    const meta = this.meta ?? (await this.ctx.storage.get<RoomMeta>('meta')) ?? null;
    if (!meta) throw new Error('This room has not been given a sheet');
    this.meta = meta;
    const stored = await readSnapshot(this.env.PRIVATE_STORAGE, meta.snapshotKey);
    const base = stored ?? { revision: 0, workbook: fallbackWorkbook() };
    const room = RoomCore.restore(base.workbook, base.revision, await this.readLog(), { onCommit: (c) => this.persist(c) });
    this.checkpointed = base.revision;
    this.sockets.clear();
    for (const ws of this.ctx.getWebSockets()) {
      const state = socketState(ws);
      if (!state) continue;
      this.sockets.set(state.peer.clientId, ws);
      room.join(state.peer, state.ready);
    }
    this.room = room;
    return room;
  }

  private async readLog(): Promise<CommittedOp[]> {
    const entries = await this.ctx.storage.list<StoredOp | string>({ prefix: OP_PREFIX });
    const ops: CommittedOp[] = [];
    for (const [key, value] of entries) {
      if (typeof value === 'string') continue; // a part, read with its head
      const op = value.op ?? (JSON.parse(partKeys(key, value.parts ?? 0).map((k) => entries.get(k) as string).join('')) as Op);
      ops.push({ revision: value.revision, batchId: value.batchId, clientId: value.clientId, op });
    }
    return ops;
  }

  // ---- Edits ----

  private persist(c: CommittedOp): void {
    const key = opKey(c.revision);
    const json = JSON.stringify(c.op);
    const head: StoredOp = { revision: c.revision, batchId: c.batchId, clientId: c.clientId };
    const entries: Record<string, StoredOp | string> = {};
    if (json.length <= OP_PART) {
      entries[key] = { ...head, op: c.op };
    } else {
      const parts = Math.ceil(json.length / OP_PART);
      entries[key] = { ...head, parts };
      partKeys(key, parts).forEach((k, i) => (entries[k] = json.slice(i * OP_PART, (i + 1) * OP_PART)));
    }
    // Not awaited: the output gate keeps the ack from leaving before this is durable.
    this.ctx.storage.put(entries).catch((err) => console.error('[sheets-api/room] logging an op failed:', err));
  }

  private edited(room: RoomCore, userId: string): void {
    this.ctx.storage.put('lastEditor', userId).catch((err) => console.error('[sheets-api/room] recording the editor failed:', err));
    if (room.revision - this.checkpointed >= CHECKPOINT_EVERY) {
      this.checkpoint().catch((err) => console.error('[sheets-api/room] checkpoint failed:', err));
    } else {
      this.scheduleCheckpoint().catch((err) => console.error('[sheets-api/room] scheduling a checkpoint failed:', err));
    }
  }

  private dispatch(room: RoomCore, out: Outgoing[]): void {
    for (const o of out) {
      const frames = toFrames(encode(o.msg), `f${++this.frameCounter}`);
      const targets =
        o.to === null
          ? [...this.sockets].filter(([id]) => id !== o.except && room.isReady(id)).map(([, ws]) => ws)
          : [this.sockets.get(o.to)].filter((ws): ws is WebSocket => !!ws);
      for (const ws of targets) {
        try {
          for (const frame of frames) ws.send(frame);
        } catch {
          // Closing; its close handler cleans up.
        }
      }
    }
  }

  private assembler(clientId: string): FrameAssembler {
    let assembler = this.assemblers.get(clientId);
    if (!assembler) {
      // A client sends one batch at a time; 64 parts is a 16 MB paste.
      assembler = new FrameAssembler(64);
      this.assemblers.set(clientId, assembler);
    }
    return assembler;
  }

  // ---- Checkpoints ----

  private async scheduleCheckpoint(): Promise<void> {
    if (this.alarmPending) return;
    this.alarmPending = true;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_DELAY_MS);
  }

  private checkpoint(): Promise<void> {
    this.checkpointing ??= this.writeCheckpoint().finally(() => {
      this.checkpointing = null;
    });
    return this.checkpointing;
  }

  private async writeCheckpoint(): Promise<void> {
    const room = this.room;
    const meta = this.meta;
    if (!room || !meta || room.revision <= this.checkpointed) return;
    // Taken in one go, so the workbook and its revision agree.
    const snapshot = { revision: room.revision, workbook: room.engine.toSnapshot() };
    // Every op the snapshot contains must be in the log before the snapshot exists.
    await this.ctx.storage.sync();
    const size = await writeSnapshot(this.env.PRIVATE_STORAGE, meta.snapshotKey, snapshot);
    this.checkpointed = snapshot.revision;
    await this.trimLog(snapshot.revision - KEEP_LOG);
    await this.report(meta, snapshot.revision, size);
    if (room.revision > this.checkpointed) await this.scheduleCheckpoint();
  }

  /** Drops logged ops up to and including `revision`. */
  private async trimLog(revision: number): Promise<void> {
    if (revision < 1) return;
    const keys = [...(await this.ctx.storage.list({ prefix: OP_PREFIX, end: opKey(revision + 1) })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }

  /** Tells the tenant DB where the checkpoint is, and everyone else that the sheet changed. */
  private async report(meta: RoomMeta, revision: number, size: number): Promise<void> {
    try {
      const editor = (await this.ctx.storage.get<string>('lastEditor')) ?? null;
      const db = await getTenantDbForWorkspace(this.env, meta.workspaceId);
      const sheet = await recordCheckpoint(db, meta.sheetId, { revision, snapshotKey: meta.snapshotKey, size, userId: editor });
      if (!sheet || !editor) return;
      await publishEntityEventRaw({
        env: this.env,
        workspaceId: meta.workspaceId,
        userId: editor,
        entityType: 'sheet',
        action: 'updated',
        entityId: sheet.id,
        data: { id: sheet.id, fileId: sheet.fileId, name: sheet.name, revision, updatedById: editor },
        source: 'web',
      });
    } catch (err) {
      // The checkpoint itself is safe in R2; the row catches up at the next one.
      console.error('[sheets-api/room] recording the checkpoint failed:', err);
    }
  }
}

/**
 * The code to answer a client's close with. 1005 (closed without a code),
 * 1006 (dropped) and the other reserved codes may not be sent, so those get a
 * normal close.
 */
export function replyCode(code: number): number {
  const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

function socketState(ws: WebSocket): SocketState | null {
  return (ws.deserializeAttachment() as SocketState | null) ?? null;
}

/** Zero-padded, so storage lists ops in revision order. */
function opKey(revision: number): string {
  return `${OP_PREFIX}${String(revision).padStart(12, '0')}`;
}

function partKeys(key: string, parts: number): string[] {
  return Array.from({ length: parts }, (_, i) => `${key}:${i}`);
}

function fallbackWorkbook(): WorkbookSnapshot {
  const workbook = new Workbook();
  workbook.sheets.push(new Sheet(FALLBACK_SHEET_ID, 'Sheet1'));
  return workbook.toJSON();
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
