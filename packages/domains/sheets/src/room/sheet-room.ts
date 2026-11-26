/**
 * SheetRoom — one Durable Object per spreadsheet (named `${workspaceId}:${sheetId}`),
 * the single place a sheet's edits are ordered (ADR SHEETS-003).
 *
 * The co-editing logic is `RoomCore` from @weldsuite/collab, run on the sheets
 * engine (@weldsuite/sheets-engine); this class gives it sockets and
 * persistence:
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
 *   - Commenters (`canComment`) may only commit comment ops (comment-access.ts).
 *     A comment's text, and its mentions, are in the sheet's WeldChat chat.
 *   - Versions: `saveVersion()` writes the live workbook to R2 for the
 *     versions route; `restoreVersion()` replaces the workbook with a saved
 *     one (see there) and tells every client with a `restored` message.
 *   - Server writes: connected tables' refreshes and agent tools commit ops
 *     through `commitServer`, like anyone's edit. Scheduled refreshes run on
 *     this object's alarm, which it shares with checkpoints.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  EN_LOCALE,
  FrameAssembler,
  NL_LOCALE,
  RoomCore,
  Sheet,
  Workbook,
  dataTableOp,
  decodeClient,
  encode,
  readValues,
  refusedBatchId,
  resolveRef,
  toFrames,
  valuesOp,
  writeCsv,
  writeXlsx,
  type CellInput,
  type CommittedOp,
  type DataTableWrite,
  type Engine,
  type Op,
  type Outgoing,
  type Peer,
  type Range,
  type ReadValues,
  type RoomOptions,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';
import { getTenantDbForWorkspace, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { getSheet, recordCheckpoint } from '../services/sheets';
import { insertVersion, versionKeyFor } from '../services/versions';
import { buildRefresh } from '../services/data-sources/refresh';
import { dataSourceEventData, dueDataSources, nextDueAt, recordRefresh, type DataSourceRecord } from '../services/data-sources/sources';
import { readSnapshot, writeSnapshot } from './snapshot';
import { isCommentersOp } from './comment-access';

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
  /** May add comments without editing (ignored when `canEdit`). */
  canComment: boolean;
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

/** A version the room wrote: the revision it is at and its size in R2. */
export interface SavedVersion {
  revision: number;
  size: number;
}

/** What the restore route asks the room. */
export interface RestoreRequest {
  sheet: RoomMeta;
  /** The version to restore, and its snapshot in R2. */
  versionId: string;
  versionKey: string;
  /** Id for the automatic version the sheet as it is now is saved as. */
  autoVersionId: string;
  userId: string;
}

export type RestoreOutcome = { ok: true; revision: number } | { ok: false; reason: 'missing_version' };

/** A tab of the workbook, and the cells it uses. */
export interface TabInfo {
  id: string;
  name: string;
  hidden: boolean;
  /** The used block in A1 notation, or null for an empty tab. */
  used: Range | null;
}

/** A range to read or write: a tab (id or name; default the first) and A1 text (default its used block). */
export interface RangeRequest {
  tab?: string;
  range?: string;
}

export type ReadResult = ({ ok: true; tabId: string; tabName: string } & ReadValues) | { ok: false; error: string };

export type WriteResult = { ok: true; revision: number; range: Range; tabId: string } | { ok: false; error: string };

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
/**
 * Storage key: logged ops below this revision belong to a workbook a restore
 * replaced, and are never replayed or sent to a client catching up.
 */
const LOG_FLOOR = 'logFloor';
/** Storage key: when the next scheduled refresh of a connected table is due (epoch ms). */
const REFRESH_AT = 'refreshAt';
/** Sheet id of the workbook a room starts from when its sheet has no checkpoint at all. */
const FALLBACK_SHEET_ID = 'sheet1';
/** Client id server writes commit under (refreshes, agent tools). */
const SERVER_CLIENT = 'server';
/** Cells an agent reads in one go at most. */
const MAX_READ_CELLS = 10_000;

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
  /** A restore in progress: messages, versions and alarms wait for it. */
  private restoring: Promise<unknown> | null = null;

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
    await this.adopt(sheet);
    await this.settled();
    const { engine } = this.room ?? (await this.load());
    return exportEngine(engine, request);
  }

  /**
   * The workbook as the room holds it now, edits not yet checkpointed
   * included (RPC for copies). As JSON text: a Durable Object RPC result is
   * typed through `Rpc.Serializable`, which does not keep the snapshot's tuples.
   */
  async snapshot(sheet: RoomMeta): Promise<{ revision: number; json: string }> {
    await this.adopt(sheet);
    await this.settled();
    const room = this.room ?? (await this.load());
    return { revision: room.revision, json: JSON.stringify(room.engine.toSnapshot()) };
  }

  /**
   * Writes the workbook as the room holds it now to `key` (RPC from the
   * versions route, which records the version row).
   */
  async saveVersion(sheet: RoomMeta, key: string): Promise<SavedVersion> {
    await this.adopt(sheet);
    await this.settled();
    const room = this.room ?? (await this.load());
    // Taken in one go, so the workbook and its revision agree.
    const snapshot = { revision: room.revision, workbook: room.engine.toSnapshot() };
    return { revision: snapshot.revision, size: await writeSnapshot(this.env.PRIVATE_STORAGE, key, snapshot) };
  }

  /**
   * Replaces the workbook with a saved version (RPC from the restore route):
   *
   *   1. The workbook as it is now is checkpointed, then saved as an
   *      automatic version (a `sheet_versions` row with no name), so the
   *      restore can be undone.
   *   2. The version becomes the workbook at the next revision: written as
   *      the checkpoint, with the op log of the replaced workbook dropped.
   *   3. Everyone connected gets a `restored` message with the new workbook.
   *
   * Edits that arrive meanwhile wait for it, then apply to the restored
   * workbook (a batch made on the old one is refused as stale and its sender
   * resyncs).
   */
  async restoreVersion(req: RestoreRequest): Promise<RestoreOutcome> {
    await this.adopt(req.sheet);
    await this.settled();
    const run = this.replaceWithVersion(req);
    this.restoring = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.restoring = null;
    }
  }

  /** The workbook's tabs and the cells each uses (RPC for agent tools). */
  async tabs(sheet: RoomMeta): Promise<TabInfo[]> {
    await this.adopt(sheet);
    await this.settled();
    const { engine } = this.room ?? (await this.load());
    return engine.workbook.sheets.map((s) => ({ id: s.id, name: s.name, hidden: !!s.props.hidden, used: engine.usedRange(s.id) }));
  }

  /** Values and formulas of a range, edits not checkpointed included (RPC for agent tools). */
  async readRange(sheet: RoomMeta, request: RangeRequest): Promise<ReadResult> {
    await this.adopt(sheet);
    await this.settled();
    const { engine } = this.room ?? (await this.load());
    const at = target(engine, request);
    if (typeof at === 'string') return { ok: false, error: at };
    const range = at.range ?? engine.usedRange(at.tabId) ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
    return { ok: true, tabId: at.tabId, tabName: at.tabName, ...readValues(engine, at.tabId, range, MAX_READ_CELLS) };
  }

  /**
   * Writes values from a range's top-left cell (RPC for agent tools), as an
   * edit by `userId` that everyone in the sheet sees at once.
   */
  async writeRange(sheet: RoomMeta, request: RangeRequest & { values: CellInput[][]; userId: string }): Promise<WriteResult> {
    await this.adopt(sheet);
    await this.settled();
    const room = this.room ?? (await this.load());
    const at = target(room.engine, request);
    if (typeof at === 'string') return { ok: false, error: at };
    const start = at.range ? { row: at.range.r1, col: at.range.c1 } : { row: 0, col: 0 };
    const width = Math.max(0, ...request.values.map((r) => r.length));
    const range = { r1: start.row, c1: start.col, r2: start.row + request.values.length - 1, c2: start.col + width - 1 };
    const result = this.commit(room, valuesOp(at.tabId, start, request.values), request.userId);
    return result.ok ? { ok: true, revision: result.revision, range, tabId: at.tabId } : result;
  }

  /**
   * Refreshes one connected table now (RPC from the data source routes): its
   * records listed by the route, written where the table is (or at `write.at`
   * for a new one).
   */
  async writeDataTable(sheet: RoomMeta, write: DataTableWrite, userId: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
    await this.adopt(sheet);
    await this.settled();
    const room = this.room ?? (await this.load());
    const op = dataTableOp(room.engine, write);
    if (typeof op === 'string') return { ok: false, error: op };
    return this.commit(room, op, userId);
  }

  /** Takes a connected table's block out of the workbook, leaving its values (RPC when a data source is removed). */
  async dropDataTable(sheet: RoomMeta, id: string, userId: string): Promise<void> {
    await this.adopt(sheet);
    await this.settled();
    const room = this.room ?? (await this.load());
    const tab = room.engine.workbook.sheets.find((s) => s.dataTables.some((t) => t.id === id));
    if (tab) this.commit(room, { type: 'patchDataTables', sheetId: tab.id, remove: [id] }, userId);
  }

  /** When the sheet's next scheduled refresh is due (epoch ms; null: none). The routes call it after changing data sources. */
  async scheduleRefresh(sheet: RoomMeta, at: number | null): Promise<void> {
    await this.adopt(sheet);
    if (at === null) await this.ctx.storage.delete(REFRESH_AT);
    else await this.ctx.storage.put(REFRESH_AT, at);
    await this.armRefresh();
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
    // Only when needed: an await here would let the next message overtake this one.
    if (this.restoring) await this.settled();
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

  /** Checkpoints after edits, and runs connected tables' scheduled refreshes when due. */
  async alarm(): Promise<void> {
    this.alarmPending = false;
    await this.settled();
    if (!this.room) await this.load();
    // A failure throws, and the runtime retries the alarm.
    await this.checkpoint();
    const due = await this.ctx.storage.get<number>(REFRESH_AT);
    if (due !== undefined && due <= Date.now()) await this.refreshDue();
    await this.armRefresh();
  }

  // ---- Loading ----

  /** Remembers which sheet this room holds (the first RPC to reach it tells it). */
  private async adopt(sheet: RoomMeta): Promise<void> {
    if (this.meta) return;
    this.meta = sheet;
    await this.ctx.storage.put('meta', sheet);
  }

  /** Waits until no restore is running. */
  private async settled(): Promise<void> {
    while (this.restoring) await this.restoring;
  }

  private roomOptions(): RoomOptions {
    return {
      onCommit: (c: CommittedOp) => this.persist(c),
      mayComment: (op, peer, engine) => isCommentersOp(op, peer.userId, engine),
    };
  }

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
    const room = RoomCore.restore(base.workbook, base.revision, await this.readLog(), this.roomOptions());
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
    const floor = (await this.ctx.storage.get<number>(LOG_FLOOR)) ?? 0;
    const ops: CommittedOp[] = [];
    for (const [key, value] of entries) {
      if (typeof value === 'string') continue; // a part, read with its head
      if (value.revision < floor) continue; // an op on a workbook a restore replaced
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

  /** Commits an op the server made as an edit by `userId`, sending it to everyone in the sheet. */
  private commit(room: RoomCore, op: Op, userId: string): { ok: true; revision: number } | { ok: false; error: string } {
    const result = room.commitServer(op, SERVER_CLIENT);
    this.dispatch(room, result.out);
    if (room.needsReload) {
      console.error('[sheets-api/room] a server op failed to apply; rebuilding the room from its checkpoint');
      this.reload();
    }
    if (!result.committed) return { ok: false, error: result.refused ?? 'refused' };
    this.edited(room, userId);
    return { ok: true, revision: result.committed.revision };
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

  // ---- Versions ----

  private async replaceWithVersion(req: RestoreRequest): Promise<RestoreOutcome> {
    const room = this.room ?? (await this.load());
    const meta = this.meta;
    if (!meta) throw new Error('This room has not been given a sheet');
    const bucket = this.env.PRIVATE_STORAGE;
    const version = await readSnapshot(bucket, req.versionKey);
    if (!version) return { ok: false, reason: 'missing_version' };

    // 1. Everything so far is in the checkpoint, so stopping halfway loses nothing.
    // (A checkpoint already running may have started before the last edits.)
    while (room.revision > this.checkpointed) await this.checkpoint();
    const current = { revision: room.revision, workbook: room.engine.toSnapshot() };
    const autoKey = versionKeyFor(meta.snapshotKey, req.autoVersionId);
    const autoSize = await writeSnapshot(bucket, autoKey, current);
    const db = await getTenantDbForWorkspace(this.env, meta.workspaceId);
    await insertVersion(db, {
      id: req.autoVersionId,
      sheetId: meta.sheetId,
      revision: current.revision,
      name: null,
      snapshotKey: autoKey,
      size: autoSize,
      createdById: req.userId,
    });

    // 2. The floor goes first: if the object stops before the new checkpoint
    // is written, it comes back as the sheet was, without the old log.
    const revision = current.revision + 1;
    const floor = (await this.ctx.storage.get<number>(LOG_FLOOR)) ?? 0;
    await this.ctx.storage.put(LOG_FLOOR, revision);
    let size: number;
    try {
      size = await writeSnapshot(bucket, meta.snapshotKey, { revision, workbook: version.workbook });
    } catch (err) {
      await this.ctx.storage.put(LOG_FLOOR, floor);
      throw err;
    }

    // 3. The new room takes over everyone connected, and tells them.
    const next = RoomCore.restore(version.workbook, revision, [], this.roomOptions());
    for (const ws of this.sockets.values()) {
      const state = socketState(ws);
      if (state) next.join(state.peer, state.ready);
    }
    this.room = next;
    this.loading = Promise.resolve(next);
    this.checkpointed = revision;
    const restored = next.engine.toSnapshot();
    this.dispatch(next, [
      { to: null, msg: { type: 'restored', revision, snapshot: restored, versionId: req.versionId, userId: req.userId } },
    ]);

    await this.ctx.storage.put('lastEditor', req.userId);
    await this.trimLog(revision - 1);
    try {
      await recordCheckpoint(db, meta.sheetId, { revision, snapshotKey: meta.snapshotKey, size, userId: req.userId });
    } catch (err) {
      // The checkpoint itself is safe in R2; the row catches up at the next one.
      console.error('[sheets-api/room] recording the restore failed:', err);
    }
    return { ok: true, revision };
  }

  // ---- Connected tables ----

  /** Refreshes every connected table whose scheduled refresh is due. */
  private async refreshDue(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    const db = await getTenantDbForWorkspace(this.env, meta.workspaceId);
    const sheet = await getSheet(db, meta.sheetId);
    if (!sheet) {
      await this.ctx.storage.delete(REFRESH_AT);
      return;
    }
    for (const source of await dueDataSources(db, meta.sheetId, new Date())) {
      try {
        await this.refreshOne(db, meta, source, sheet.file);
      } catch (err) {
        console.error('[sheets-api/room] scheduled refresh failed:', err);
        await recordRefresh(db, source, { at: new Date(), error: 'failed' }).catch(() => null);
      }
    }
    const next = await nextDueAt(db, meta.sheetId);
    if (next) await this.ctx.storage.put(REFRESH_AT, next.getTime());
    else await this.ctx.storage.delete(REFRESH_AT);
  }

/** Lists one connected table's records and writes them, recording how it went. */
  private async refreshOne(db: Database, meta: RoomMeta, source: DataSourceRecord, file: DriveFileRef): Promise<void> {
    const plan = await buildRefresh(db, source, file);
    let error = plan.ok ? null : plan.error;
    if (plan.ok) {
      const room = this.room ?? (await this.load());
      const op = dataTableOp(room.engine, plan.write);
      error = typeof op === 'string' || !this.commit(room, op, source.createdById).ok ? 'unplaced' : null;
    }
    const row = await recordRefresh(db, source, { at: new Date(), rowCount: plan.ok ? plan.rowCount : 0, error });
    if (!row) return;
    await publishEntityEventRaw({
      env: this.env,
      workspaceId: meta.workspaceId,
      userId: source.createdById,
      entityType: 'sheet_data_source',
      action: 'updated',
      entityId: row.id,
      data: dataSourceEventData(row) as unknown as Record<string, unknown>,
      source: 'system',
    });
  }

  /** Sets the alarm for the next scheduled refresh, unless an earlier one (a checkpoint) is set. */
  private async armRefresh(): Promise<void> {
    const at = await this.ctx.storage.get<number>(REFRESH_AT);
    if (at === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }

  // ---- Checkpoints ----

  private async scheduleCheckpoint(): Promise<void> {
    if (this.alarmPending) return;
    this.alarmPending = true;
    const at = Date.now() + CHECKPOINT_DELAY_MS;
    // A scheduled refresh may hold the alarm for later: the checkpoint comes first.
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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

/** The workbook as an .xlsx, or one tab as a CSV (null when that tab does not exist). */
export async function exportEngine(engine: Engine, request: ExportRequest): Promise<ExportedFile | null> {
  const locale = request.locale === 'nl' ? NL_LOCALE : EN_LOCALE;
  if (request.format === 'xlsx') return { bytes: await writeXlsx(engine, { locale }), tabName: null };
  const sheets = engine.workbook.sheets;
  const tab = request.tab ? engine.workbook.getSheet(request.tab) : (sheets.find((s) => !s.props.hidden) ?? sheets[0]);
  if (!tab) return null;
  // A byte-order mark, so Excel reads the CSV as UTF-8.
  return { bytes: new TextEncoder().encode(`﻿${writeCsv(engine, tab.id, { locale })}`), tabName: tab.name };
}

/** The tab and range a request names, or why it names none. */
function target(engine: Engine, request: RangeRequest): { tabId: string; tabName: string; range: Range | null } | string {
  const sheets = engine.workbook.sheets;
  const tab = request.tab
    ? (engine.workbook.getSheet(request.tab) ?? engine.workbook.getSheetByName(request.tab))
    : (sheets.find((s) => !s.props.hidden) ?? sheets[0]);
  if (!tab) return `There is no tab "${request.tab}"`;
  if (!request.range) return { tabId: tab.id, tabName: tab.name, range: null };
  const at = resolveRef(engine, request.range, tab.id);
  if (!at) return `"${request.range}" is not a range like A1:C10`;
  const sheet = engine.workbook.getSheet(at.sheetId)!;
  return { tabId: sheet.id, tabName: sheet.name, range: at.range };
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
