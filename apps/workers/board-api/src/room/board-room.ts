/**
 * BoardRoom: one Durable Object per board (named `${workspaceId}:${boardId}`),
 * the single place a board's edits are ordered (docs/plans/weldboard.md, ADR
 * BOARD-003). Built like DocRoom and SheetRoom.
 *
 * The co-editing logic is `RoomCore` from @weldsuite/collab, run on the board
 * engine's adapter; this class gives it sockets and persistence:
 *
 *   - Admission: the session route checks access, then calls `admit()` (RPC)
 *     for a single-use ticket; the browser opens the socket with it.
 *   - Sockets use the hibernation API. Each socket's attachment carries its
 *     peer, so a room that wakes up re-admits the people still connected.
 *   - Every committed op is written to this object's storage before the ack
 *     can leave (the output gate holds sends until writes are durable).
 *   - Checkpoints: the whole board goes to R2 (one object per board) every
 *     CHECKPOINT_EVERY ops, CHECKPOINT_DELAY_MS after an edit, and when the
 *     last person leaves, with a fresh SVG thumbnail next to it. Ops older
 *     than the checkpoint are trimmed, except the last KEEP_LOG for clients
 *     catching up. The tenant DB row then records the new revision and an
 *     entity event reports the change.
 *   - Server writes (`applyOps`): an op made on the server (the legacy
 *     whiteboard API, an agent tool, an AI action) is committed like a
 *     client's and sent to everyone connected, so nobody races a checkpoint.
 *   - Messages longer than a frame go as parts (`toFrames`/`FrameAssembler`).
 *   - Commenters (`canComment`) may only commit comment pins (comment-access.ts).
 *   - Versions: `saveVersion()` writes the live board to R2 for the versions
 *     route; `restoreVersion()` replaces the board with a saved one and tells
 *     every client with a `restored` message.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  FrameAssembler,
  RoomCore,
  decodeClient,
  encode,
  refusedBatchId,
  toFrames,
  type CommittedOp,
  type Outgoing,
  type Peer,
  type RoomOptions,
} from '@weldsuite/collab';
import {
  Board,
  boardAdapter,
  boardDisplay,
  boardToPlainText,
  displayToSvg,
  emptySnapshot,
  selectionBounds,
  type BoardPresence,
  type BoardSnapshot,
  type Op,
} from '@weldsuite/board-engine';
import { CachedMeasurer, MetricsMeasurer } from '@weldsuite/docs-engine';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { recordCheckpoint } from '../services/boards';
import { insertVersion, versionKeyFor } from '../services/versions';
import { readSnapshot, writeSnapshot, writeThumbnail } from './snapshot';
import { isCommentersOp } from './comment-access';

type BoardRoomCore = RoomCore<Board, Op, BoardSnapshot, BoardPresence>;
type BoardPeer = Peer<BoardPresence>;
type BoardOutgoing = Outgoing<Op, BoardSnapshot, BoardPresence>;
type BoardCommittedOp = CommittedOp<Op>;

/** What the session route tells the room: which board it is, and who is coming in. */
export interface Admission {
  /** Clerk org id (what worker-kit calls the workspace id). */
  workspaceId: string;
  boardId: string;
  snapshotKey: string;
  userId: string;
  name: string;
  picture: string | null;
  color: string;
  canEdit: boolean;
  /** May add comment pins without editing (ignored when `canEdit`). */
  canComment: boolean;
}

/** Which board a room holds, and where its checkpoint is. */
export interface RoomMeta {
  workspaceId: string;
  boardId: string;
  snapshotKey: string;
}

/** The board as the room holds it now, as JSON text (Durable Object RPC results do not keep tuples). */
export interface LiveSnapshot {
  revision: number;
  json: string;
}

export interface SavedVersion {
  revision: number;
  size: number;
}

export interface RestoreRequest {
  board: RoomMeta;
  versionId: string;
  versionKey: string;
  autoVersionId: string;
  userId: string;
}

export type RestoreOutcome = { ok: true; revision: number } | { ok: false; reason: 'missing_version' };

/** What a server write did. `refused` says why it was not committed. */
export interface ServerWriteResult {
  revision: number;
  committed: boolean;
  refused?: string;
}

interface Ticket {
  peer: Omit<BoardPeer, 'clientId'>;
  expires: number;
}

interface SocketState {
  peer: BoardPeer;
  ready: boolean;
}

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
const OP_PART = 1_000_000;
const OP_PREFIX = 'op:';
const TICKET_PREFIX = 'ticket:';
const LOG_FLOOR = 'logFloor';
/** A thumbnail draws at most this many elements (the rest of a huge board is not worth the bytes). */
const THUMBNAIL_ELEMENTS = 1500;

const thumbnailMeasurer = new CachedMeasurer(new MetricsMeasurer(), 50_000);

export class BoardRoom extends DurableObject<Env> {
  private room: BoardRoomCore | null = null;
  private loading: Promise<BoardRoomCore> | null = null;
  private meta: RoomMeta | null = null;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly assemblers = new Map<string, FrameAssembler>();
  private checkpointed = 0;
  private checkpointing: Promise<void> | null = null;
  private alarmPending = false;
  private frameCounter = 0;
  private restoring: Promise<unknown> | null = null;

  /** Registers a ticket for one connection (RPC from the session route). */
  async admit(admission: Admission): Promise<string> {
    const { workspaceId, boardId, snapshotKey, ...peer } = admission;
    this.meta ??= { workspaceId, boardId, snapshotKey };
    const secret = randomToken();
    const now = Date.now();
    const expired = [...(await this.ctx.storage.list<Ticket>({ prefix: TICKET_PREFIX })).entries()]
      .filter(([, ticket]) => ticket.expires < now)
      .map(([key]) => key);
    if (expired.length > 0) await this.ctx.storage.delete(expired.slice(0, 128));
    await this.ctx.storage.put<unknown>({
      meta: { workspaceId, boardId, snapshotKey },
      [`${TICKET_PREFIX}${secret}`]: { peer, expires: now + TICKET_TTL_MS } satisfies Ticket,
    });
    return `${this.ctx.id.toString()}.${secret}`;
  }

  /** The board as the room holds it now, edits not yet checkpointed included. */
  async snapshot(board: RoomMeta): Promise<LiveSnapshot> {
    await this.adopt(board);
    await this.settled();
    const room = this.room ?? (await this.load());
    return { revision: room.revision, json: JSON.stringify(room.state.toSnapshot()) };
  }

  /** The board as plain text (search, AI, agents). */
  async plainText(board: RoomMeta): Promise<string> {
    await this.adopt(board);
    await this.settled();
    const room = this.room ?? (await this.load());
    return boardToPlainText(room.state);
  }

  /**
   * Commits an op made on the server, as `userId`, against the current
   * revision, and sends it to everyone connected (RPC from BoardsInternal and
   * the AI and task routes). Callers build the op on a fresh `snapshot()`.
   */
  async applyOps(board: RoomMeta, op: Op, userId: string): Promise<ServerWriteResult> {
    await this.adopt(board);
    await this.settled();
    const room = this.room ?? (await this.load());
    const result = room.commitServer(op, `server:${userId}`);
    this.dispatch(room, result.out);
    if (room.needsReload) {
      this.reload();
      return { revision: room.revision, committed: false, refused: result.refused ?? 'the op failed to apply' };
    }
    if (result.committed) this.edited(room, userId);
    return { revision: room.revision, committed: !!result.committed, ...(result.refused ? { refused: result.refused } : {}) };
  }

  async saveVersion(board: RoomMeta, key: string): Promise<SavedVersion> {
    await this.adopt(board);
    await this.settled();
    const room = this.room ?? (await this.load());
    const snapshot = { revision: room.revision, board: room.state.toSnapshot() };
    return { revision: snapshot.revision, size: await writeSnapshot(this.env.PRIVATE_STORAGE, key, snapshot) };
  }

  async restoreVersion(req: RestoreRequest): Promise<RestoreOutcome> {
    await this.adopt(req.board);
    await this.settled();
    const run = this.replaceWithVersion(req);
    this.restoring = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.restoring = null;
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const secret = new URL(request.url).searchParams.get('ticket')?.split('.')[1] ?? null;
    const outcome = await this.accept(pair[1], secret);
    if (outcome === 'invalid') return new Response('Invalid or expired ticket', { status: 401 });
    if (outcome === 'unavailable') return new Response('Board unavailable', { status: 503 });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Takes the server end of a new socket if its ticket is good (split from `fetch` for tests). */
  async accept(server: WebSocket, secret: string | null): Promise<'ok' | 'invalid' | 'unavailable'> {
    const key = `${TICKET_PREFIX}${secret ?? ''}`;
    const ticket = secret ? await this.ctx.storage.get<Ticket>(key) : undefined;
    if (!ticket || ticket.expires < Date.now()) return 'invalid';
    await this.ctx.storage.delete(key);

    let room: BoardRoomCore;
    try {
      room = await this.load();
    } catch (err) {
      console.error('[board-api/room] loading the board failed:', err);
      return 'unavailable';
    }
    const peer: BoardPeer = { clientId: crypto.randomUUID(), ...ticket.peer };
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
    if (this.restoring) await this.settled();
    let room: BoardRoomCore;
    try {
      room = this.room ?? (await this.load());
    } catch (err) {
      console.error('[board-api/room] loading the board failed:', err);
      ws.close(1011, 'Board unavailable');
      return;
    }
    const text = this.assembler(state.peer.clientId).accept(message);
    if (text === null) return;
    const msg = decodeClient(text, shapeChecks);
    if (!msg) {
      const batchId = refusedBatchId(text);
      if (batchId) this.dispatch(room, room.refuse(state.peer.clientId, batchId));
      return;
    }

    const before = room.revision;
    let out: BoardOutgoing[];
    try {
      out = room.receive(state.peer.clientId, msg);
    } catch (err) {
      console.error('[board-api/room] handling a message failed:', err);
      this.reload();
      return;
    }
    if (msg.type === 'hello' && !state.ready) ws.serializeAttachment({ ...state, ready: true } satisfies SocketState);
    this.dispatch(room, out);
    if (room.needsReload) {
      console.error('[board-api/room] an op failed to apply; rebuilding the room from its checkpoint');
      this.reload();
      return;
    }
    if (room.revision > before) this.edited(room, state.peer.userId);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = socketState(ws);
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
    if (this.sockets.size === 0) await this.checkpoint().catch((err) => console.error('[board-api/room] checkpoint failed:', err));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  async alarm(): Promise<void> {
    this.alarmPending = false;
    await this.settled();
    if (!this.room) await this.load();
    await this.checkpoint();
  }

  // ---- Loading ----

  private async adopt(board: RoomMeta): Promise<void> {
    if (this.meta) return;
    this.meta = board;
    await this.ctx.storage.put('meta', board);
  }

  private async settled(): Promise<void> {
    while (this.restoring) await this.restoring;
  }

  private roomOptions(): RoomOptions<Op, Board, BoardPresence> {
    return {
      onCommit: (c) => this.persist(c),
      mayComment: (op, peer, board) => isCommentersOp(op, peer.userId, board),
    };
  }

  private reload(): void {
    this.room = null;
    this.loading = null;
    this.sockets.clear();
    this.assemblers.clear();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1012, 'Reloading the board');
      } catch {
        // Already closing.
      }
    }
  }

  private load(): Promise<BoardRoomCore> {
    this.loading ??= this.restore().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async restore(): Promise<BoardRoomCore> {
    const meta = this.meta ?? (await this.ctx.storage.get<RoomMeta>('meta')) ?? null;
    if (!meta) throw new Error('This room has not been given a board');
    this.meta = meta;
    const stored = await readSnapshot(this.env.PRIVATE_STORAGE, meta.snapshotKey);
    const base = stored ?? { revision: 0, board: emptySnapshot() };
    const room = RoomCore.restore(boardAdapter(), base.board, base.revision, await this.readLog(), this.roomOptions());
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

  private async readLog(): Promise<BoardCommittedOp[]> {
    const entries = await this.ctx.storage.list<StoredOp | string>({ prefix: OP_PREFIX });
    const floor = (await this.ctx.storage.get<number>(LOG_FLOOR)) ?? 0;
    const ops: BoardCommittedOp[] = [];
    for (const [key, value] of entries) {
      if (typeof value === 'string') continue;
      if (value.revision < floor) continue;
      const op = value.op ?? (JSON.parse(partKeys(key, value.parts ?? 0).map((k) => entries.get(k) as string).join('')) as Op);
      ops.push({ revision: value.revision, batchId: value.batchId, clientId: value.clientId, op });
    }
    return ops;
  }

  // ---- Edits ----

  private persist(c: BoardCommittedOp): void {
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
    this.ctx.storage.put(entries).catch((err) => console.error('[board-api/room] logging an op failed:', err));
  }

  private edited(room: BoardRoomCore, userId: string): void {
    this.ctx.storage.put('lastEditor', userId).catch((err) => console.error('[board-api/room] recording the editor failed:', err));
    if (room.revision - this.checkpointed >= CHECKPOINT_EVERY) {
      this.checkpoint().catch((err) => console.error('[board-api/room] checkpoint failed:', err));
    } else {
      this.scheduleCheckpoint().catch((err) => console.error('[board-api/room] scheduling a checkpoint failed:', err));
    }
  }

  private dispatch(room: BoardRoomCore, out: BoardOutgoing[]): void {
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
    if (!meta) throw new Error('This room has not been given a board');
    const bucket = this.env.PRIVATE_STORAGE;
    const version = await readSnapshot(bucket, req.versionKey);
    if (!version) return { ok: false, reason: 'missing_version' };
    const restored = Board.fromSnapshot(version.board).toSnapshot();

    while (room.revision > this.checkpointed) await this.checkpoint();
    const current = { revision: room.revision, board: room.state.toSnapshot() };
    const autoKey = versionKeyFor(meta.snapshotKey, req.autoVersionId);
    const autoSize = await writeSnapshot(bucket, autoKey, current);
    const db = await getTenantDbForWorkspace(this.env, meta.workspaceId);
    await insertVersion(db, {
      id: req.autoVersionId,
      boardId: meta.boardId,
      revision: current.revision,
      name: null,
      snapshotKey: autoKey,
      size: autoSize,
      createdById: req.userId,
    });

    const revision = current.revision + 1;
    const floor = (await this.ctx.storage.get<number>(LOG_FLOOR)) ?? 0;
    await this.ctx.storage.put(LOG_FLOOR, revision);
    let size: number;
    try {
      size = await writeSnapshot(bucket, meta.snapshotKey, { revision, board: restored });
    } catch (err) {
      await this.ctx.storage.put(LOG_FLOOR, floor);
      throw err;
    }

    const next = RoomCore.restore(boardAdapter(), restored, revision, [], this.roomOptions());
    for (const ws of this.sockets.values()) {
      const state = socketState(ws);
      if (state) next.join(state.peer, state.ready);
    }
    this.room = next;
    this.loading = Promise.resolve(next);
    this.checkpointed = revision;
    this.dispatch(next, [{ to: null, msg: { type: 'restored', revision, snapshot: restored, versionId: req.versionId, userId: req.userId } }]);

    await this.ctx.storage.put('lastEditor', req.userId);
    await this.trimLog(revision - 1);
    try {
      await recordCheckpoint(db, meta.boardId, { revision, snapshotKey: meta.snapshotKey, size, userId: req.userId });
      await this.thumbnail(next.state, meta);
    } catch (err) {
      console.error('[board-api/room] recording the restore failed:', err);
    }
    return { ok: true, revision };
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
    const snapshot = { revision: room.revision, board: room.state.toSnapshot() };
    await this.ctx.storage.sync();
    const size = await writeSnapshot(this.env.PRIVATE_STORAGE, meta.snapshotKey, snapshot);
    this.checkpointed = snapshot.revision;
    await this.trimLog(snapshot.revision - KEEP_LOG);
    await this.thumbnail(room.state, meta).catch((err) => console.error('[board-api/room] thumbnail failed:', err));
    await this.report(meta, snapshot.revision, size);
    if (room.revision > this.checkpointed) await this.scheduleCheckpoint();
  }

  /** A small SVG of the board, for the home page and WeldDrive. */
  private async thumbnail(board: Board, meta: RoomMeta): Promise<void> {
    const ids = board.paintOrder().slice(0, THUMBNAIL_ELEMENTS).map((e) => e.id);
    const only = new Set(ids);
    const view = selectionBounds(board, only);
    if (!view) return;
    const svg = displayToSvg(boardDisplay(board, { measurer: thumbnailMeasurer }, only), { view, width: 480, padding: 32, background: '#f7f8fa' });
    await writeThumbnail(this.env.PRIVATE_STORAGE, meta.snapshotKey, svg);
  }

  private async trimLog(revision: number): Promise<void> {
    if (revision < 1) return;
    const keys = [...(await this.ctx.storage.list({ prefix: OP_PREFIX, end: opKey(revision + 1) })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }

  private async report(meta: RoomMeta, revision: number, size: number): Promise<void> {
    try {
      const editor = (await this.ctx.storage.get<string>('lastEditor')) ?? null;
      const db = await getTenantDbForWorkspace(this.env, meta.workspaceId);
      const board = await recordCheckpoint(db, meta.boardId, { revision, snapshotKey: meta.snapshotKey, size, userId: editor });
      if (!board || !editor || editor.startsWith('server:')) return;
      await publishEntityEventRaw({
        env: this.env,
        workspaceId: meta.workspaceId,
        userId: editor,
        entityType: 'board',
        action: 'updated',
        entityId: board.id,
        data: { id: board.id, fileId: board.fileId, name: board.name, projectId: board.projectId, revision, updatedById: editor },
        source: 'web',
      });
    } catch (err) {
      console.error('[board-api/room] recording the checkpoint failed:', err);
    }
  }
}

const shapeChecks = boardAdapter();

export function replyCode(code: number): number {
  const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

function socketState(ws: WebSocket): SocketState | null {
  return (ws.deserializeAttachment() as SocketState | null) ?? null;
}

function opKey(revision: number): string {
  return `${OP_PREFIX}${String(revision).padStart(12, '0')}`;
}

function partKeys(key: string, parts: number): string[] {
  return Array.from({ length: parts }, (_, i) => `${key}:${i}`);
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
