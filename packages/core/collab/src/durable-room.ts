/**
 * CollabRoom: the Durable Object around a `RoomCore`, one per open document
 * (named `${workspaceId}:${id}`), the single place its edits are ordered.
 * WeldDocs' DocRoom, WeldSheets' SheetRoom and WeldBoard's BoardRoom extend
 * it. The co-editing logic is `RoomCore`; this class gives it sockets and
 * persistence:
 *
 *   - Admission: the session route checks access, then calls the room's
 *     `admit()` (RPC), which issues a single-use ticket (`issueTicket`); the
 *     browser opens the socket with it.
 *   - Sockets use the hibernation API. Each socket's attachment carries its
 *     peer, so a room that wakes up re-admits the people still connected.
 *   - Every committed op is written to this object's storage before the ack
 *     can leave (the output gate holds sends until writes are durable).
 *   - Checkpoints: the whole document goes to R2 (one object per document,
 *     see checkpoint.ts) every CHECKPOINT_EVERY ops, CHECKPOINT_DELAY_MS after
 *     an edit, and when the last person leaves. Ops older than the checkpoint
 *     are trimmed, except the last KEEP_LOG for clients catching up. The
 *     subclass then records the new revision in the tenant DB and reports the
 *     change (`recordCheckpoint`).
 *   - Messages longer than a frame go as parts (`toFrames`/`FrameAssembler`).
 *   - Versions: `saveVersion()` writes the live document to R2 for the
 *     versions route; `restoreTo()` replaces the document with a saved one
 *     (see there) and tells every client with a `restored` message.
 *   - Server writes (`commitServerOp`): an op made on the server is committed
 *     like a client's and sent to everyone connected.
 *
 * What differs per kind of document (the engine, where its checkpoint and
 * versions are recorded, who may comment) comes from the abstract members.
 * The class runs as a Durable Object on Cloudflare and on Node in
 * apps/tools/collab-rooms, whose build swaps in its own `cloudflare:workers`.
 */

import { DurableObject } from 'cloudflare:workers';
import { FrameAssembler, decodeClient, encode, refusedBatchId, toFrames, type CommittedOp, type Peer, type ShapeChecks } from './protocol';
import type { Outgoing, RoomCore, RoomOptions } from './room';

/** Which document a room holds, and where its checkpoint is (the subclass adds the document's id). */
export interface RoomMeta {
  /** Clerk org id (what worker-kit calls the workspace id). */
  workspaceId: string;
  snapshotKey: string;
}

/** Who the session route lets in: the peer without its connection's client id. */
export type AdmittedPeer = Omit<Peer<never>, 'clientId' | 'presence'>;

/**
 * The document as the room holds it now. The snapshot travels as JSON text:
 * a Durable Object RPC result is typed through `Rpc.Serializable`, which does
 * not keep the snapshot's tuples, and the route sends the text on as it is.
 */
export interface LiveSnapshot {
  revision: number;
  json: string;
}

/** A version the room wrote: the revision it is at and its size in R2. */
export interface SavedVersion {
  revision: number;
  size: number;
}

/** What the restore route asks the room, besides which document. */
export interface VersionRestore {
  /** The version to restore, and its snapshot in R2. */
  versionId: string;
  versionKey: string;
  /** Id for the automatic version the document as it is now is saved as. */
  autoVersionId: string;
  userId: string;
}

export type RestoreOutcome = { ok: true; revision: number } | { ok: false; reason: 'missing_version' };

/** A checkpoint to record in the tenant DB. `userId`: who edited last (null when unknown). */
export interface CheckpointRecord {
  revision: number;
  snapshotKey: string;
  size: number;
  userId: string | null;
}

/** The automatic version a restore saves first (a version row with no name). */
export interface AutoVersion {
  id: string;
  revision: number;
  snapshotKey: string;
  size: number;
  createdById: string;
}

/** What a server write did: the committed op, or why it was refused. */
export interface ServerCommit<Op> {
  committed: CommittedOp<Op> | null;
  refused?: string;
}

interface Ticket<Presence> {
  peer: Omit<Peer<Presence>, 'clientId'>;
  expires: number;
}

/** Kept on each socket, so it survives hibernation. */
interface SocketState<Presence> {
  peer: Peer<Presence>;
  /** Said hello, so receives broadcasts. */
  ready: boolean;
}

/** A logged op. Ops too big for one storage value keep their JSON in `parts` extra keys. */
interface StoredOp<Op> {
  revision: number;
  batchId: string;
  clientId: string;
  op?: Op;
  parts?: number;
}

const TICKET_TTL_MS = 60_000;
export const CHECKPOINT_EVERY = 200;
export const CHECKPOINT_DELAY_MS = 30_000;
export const KEEP_LOG = 500;
/** Characters per stored part; SQLite-backed objects take values up to 2 MiB. */
const OP_PART = 1_000_000;
const OP_PREFIX = 'op:';
const TICKET_PREFIX = 'ticket:';
/**
 * Storage key: logged ops below this revision belong to a document a restore
 * replaced, and are never replayed or sent to a client catching up.
 */
const LOG_FLOOR = 'logFloor';
/** Storage key: who edited last, for the checkpoint's row and event. */
const LAST_EDITOR = 'lastEditor';

export abstract class CollabRoom<
  Env,
  Meta extends RoomMeta,
  State,
  Op,
  Snapshot,
  Presence,
  Core extends RoomCore<State, Op, Snapshot, Presence> = RoomCore<State, Op, Snapshot, Presence>,
> extends DurableObject<Env> {
  protected room: Core | null = null;
  protected meta: Meta | null = null;
  private loading: Promise<Core> | null = null;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly assemblers = new Map<string, FrameAssembler>();
  /** Revision of the latest checkpoint in R2. */
  private checkpointed = 0;
  private checkpointing: Promise<void> | null = null;
  private alarmPending = false;
  private frameCounter = 0;
  /** A restore in progress: messages, versions and alarms wait for it. */
  private restoring: Promise<unknown> | null = null;

  // ---- What each kind of document fills in ----

  /** Prefix of this room's log lines, e.g. `[docs-api/room]`. */
  protected abstract readonly logPrefix: string;
  /** What the room holds, in messages: `document`, `sheet`, `board`. */
  protected abstract readonly noun: string;
  /** Checks what a browser sends (the engine's adapter). */
  protected abstract readonly shapeChecks: ShapeChecks<Op, Presence>;
  /** A room on `snapshot` at `revision`, brought up to date with `ops`. */
  protected abstract createRoom(snapshot: Snapshot, revision: number, ops: CommittedOp<Op>[], options: RoomOptions<Op, State, Presence>): Core;
  /** What a document with no checkpoint at all starts from. */
  protected abstract emptySnapshot(): Snapshot;
  /** The document as the room holds it now. */
  protected abstract snapshotOf(room: Core): Snapshot;
  /** A checkpoint or version from R2, or null when there is none. */
  protected abstract readStored(key: string): Promise<{ revision: number; snapshot: Snapshot } | null>;
  /** Writes a checkpoint or version to R2; returns its size in bytes. */
  protected abstract writeStored(key: string, revision: number, snapshot: Snapshot): Promise<number>;
  /**
   * Records where the checkpoint is in the tenant DB. `announce` (a checkpoint
   * after edits, not a restore): also report the change with an entity event.
   */
  protected abstract recordCheckpoint(meta: Meta, checkpoint: CheckpointRecord, announce: boolean): Promise<void>;
  /** Records the automatic version a restore saves first. */
  protected abstract saveAutoVersion(meta: Meta, version: AutoVersion): Promise<void>;
  /** Where the automatic version a restore saves first goes in R2. */
  protected abstract versionKeyFor(snapshotKey: string, versionId: string): string;

  /** Who may commit what beyond editors' rights (`mayComment`, `mayCommit`). */
  protected accessRules(): Pick<RoomOptions<Op, State, Presence>, 'mayComment' | 'mayCommit'> {
    return {};
  }

  /** The document a saved version becomes (as written to the checkpoint). */
  protected restoredFrom(version: Snapshot): Snapshot {
    return version;
  }

  /** Runs after each checkpoint and restore is in R2 (WeldBoard draws its thumbnail). */
  protected async afterCheckpoint(_room: Core, _meta: Meta): Promise<void> {
    // Nothing by default.
  }

  /**
   * Whether a checkpoint due at `at` sets the alarm, which is at `current`.
   * By default only an unset alarm is; a room whose alarm also runs other
   * work later moves it earlier.
   */
  protected checkpointSetsAlarm(current: number | null, _at: number): boolean {
    return current === null;
  }

  // ---- RPC ----

  /** Registers a ticket for one connection; the subclass's `admit()` (RPC from the session route) calls it. */
  protected async issueTicket(meta: Meta, peer: AdmittedPeer): Promise<string> {
    this.meta ??= meta;
    const secret = randomToken();
    const now = Date.now();
    const expired = [...(await this.ctx.storage.list<Ticket<Presence>>({ prefix: TICKET_PREFIX })).entries()]
      .filter(([, ticket]) => ticket.expires < now)
      .map(([key]) => key);
    if (expired.length > 0) await this.ctx.storage.delete(expired.slice(0, 128));
    await this.ctx.storage.put<unknown>({
      meta,
      [`${TICKET_PREFIX}${secret}`]: { peer, expires: now + TICKET_TTL_MS } satisfies Ticket<Presence>,
    });
    return `${this.ctx.id.toString()}.${secret}`;
  }

  /**
   * The document as the room holds it now, edits not yet checkpointed
   * included (RPC from the snapshot route, and for copies).
   */
  async snapshot(meta: Meta): Promise<LiveSnapshot> {
    const room = await this.roomFor(meta);
    return { revision: room.revision, json: JSON.stringify(this.snapshotOf(room)) };
  }

  /**
   * Writes the document as the room holds it now to `key` (RPC from the
   * versions route, which records the version row).
   */
  async saveVersion(meta: Meta, key: string): Promise<SavedVersion> {
    const room = await this.roomFor(meta);
    // Taken in one go, so the document and its revision agree.
    const revision = room.revision;
    return { revision, size: await this.writeStored(key, revision, this.snapshotOf(room)) };
  }

  /**
   * Replaces the document with a saved version (the subclass's
   * `restoreVersion()`, RPC from the restore route, calls it):
   *
   *   1. The document as it is now is checkpointed, then saved as an
   *      automatic version (a version row with no name), so the restore can
   *      be undone.
   *   2. The version becomes the document at the next revision: written as
   *      the checkpoint, with the op log of the replaced document dropped.
   *   3. Everyone connected gets a `restored` message with the new document.
   *
   * Edits that arrive meanwhile wait for it, then apply to the restored
   * document (a batch made on the old one is refused as stale and its sender
   * resyncs).
   */
  protected async restoreTo(meta: Meta, request: VersionRestore): Promise<RestoreOutcome> {
    await this.adopt(meta);
    await this.settled();
    const run = this.replaceWithVersion(request);
    this.restoring = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.restoring = null;
    }
  }

  // ---- Sockets ----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const secret = new URL(request.url).searchParams.get('ticket')?.split('.')[1] ?? null;
    const outcome = await this.accept(pair[1], secret);
    if (outcome === 'invalid') return new Response('Invalid or expired ticket', { status: 401 });
    if (outcome === 'unavailable') return new Response(this.unavailable(), { status: 503 });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Takes the server end of a new socket if its ticket is good (split from `fetch` for tests). */
  async accept(server: WebSocket, secret: string | null): Promise<'ok' | 'invalid' | 'unavailable'> {
    const key = `${TICKET_PREFIX}${secret ?? ''}`;
    const ticket = secret ? await this.ctx.storage.get<Ticket<Presence>>(key) : undefined;
    if (!ticket || ticket.expires < Date.now()) return 'invalid';
    await this.ctx.storage.delete(key);

    let room: Core;
    try {
      room = await this.load();
    } catch (err) {
      console.error(`${this.logPrefix} loading the ${this.noun} failed:`, err);
      return 'unavailable';
    }
    const peer: Peer<Presence> = { clientId: crypto.randomUUID(), ...ticket.peer };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer, ready: false } satisfies SocketState<Presence>);
    this.sockets.set(peer.clientId, server);
    room.join(peer);
    return 'ok';
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const state = socketState<Presence>(ws);
    if (!state) return;
    // Only when needed: an await here would let the next message overtake this one.
    if (this.restoring) await this.settled();
    let room: Core;
    try {
      room = this.room ?? (await this.load());
    } catch (err) {
      console.error(`${this.logPrefix} loading the ${this.noun} failed:`, err);
      ws.close(1011, this.unavailable());
      return;
    }
    const text = this.assembler(state.peer.clientId).accept(message);
    if (text === null) return;
    const msg = decodeClient(text, this.shapeChecks);
    if (!msg) {
      // Malformed: never applied. A submit still gets its answer, or the sender would wait for ever.
      const batchId = refusedBatchId(text);
      if (batchId) this.dispatch(room, room.refuse(state.peer.clientId, batchId));
      return;
    }

    const before = room.revision;
    let out: Outgoing<Op, Snapshot, Presence>[];
    try {
      out = room.receive(state.peer.clientId, msg);
    } catch (err) {
      console.error(`${this.logPrefix} handling a message failed:`, err);
      this.reload();
      return;
    }
    if (msg.type === 'hello' && !state.ready) ws.serializeAttachment({ ...state, ready: true } satisfies SocketState<Presence>);
    this.dispatch(room, out);
    if (room.needsReload) {
      console.error(`${this.logPrefix} an op failed to apply; rebuilding the room from its checkpoint`);
      this.reload();
      return;
    }
    if (room.revision > before) this.edited(room, state.peer.userId);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = socketState<Presence>(ws);
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
    if (this.sockets.size === 0) await this.checkpoint().catch((err) => console.error(`${this.logPrefix} checkpoint failed:`, err));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  /** Checkpoints after edits. */
  async alarm(): Promise<void> {
    this.alarmPending = false;
    await this.settled();
    if (!this.room) await this.load();
    // A failure throws, and the runtime retries the alarm.
    await this.checkpoint();
  }

  // ---- Loading ----

  /** The room for an RPC: told which document it holds, no restore running, loaded. */
  protected async roomFor(meta: Meta): Promise<Core> {
    await this.adopt(meta);
    await this.settled();
    return this.room ?? (await this.load());
  }

  /** Remembers which document this room holds (the first RPC to reach it tells it). */
  protected async adopt(meta: Meta): Promise<void> {
    if (this.meta) return;
    this.meta = meta;
    await this.ctx.storage.put('meta', meta);
  }

  /** Waits until no restore is running. */
  protected async settled(): Promise<void> {
    while (this.restoring) await this.restoring;
  }

  protected load(): Promise<Core> {
    this.loading ??= this.rebuild().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /**
   * Drops the in-memory room, whose document may be half-changed, and closes
   * every socket. Clients reconnect and catch up from a room rebuilt from the
   * checkpoint and the log, which only hold committed ops.
   */
  protected reload(): void {
    this.room = null;
    this.loading = null;
    this.sockets.clear();
    this.assemblers.clear();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1012, `Reloading the ${this.noun}`);
      } catch {
        // Already closing.
      }
    }
  }

  private roomOptions(): RoomOptions<Op, State, Presence> {
    return { onCommit: (c) => this.persist(c), ...this.accessRules() };
  }

  /** The room from the checkpoint and the log, with the sockets still open. */
  private async rebuild(): Promise<Core> {
    const meta = this.meta ?? (await this.ctx.storage.get<Meta>('meta')) ?? null;
    if (!meta) throw new Error(`This room has not been given a ${this.noun}`);
    this.meta = meta;
    const stored = await this.readStored(meta.snapshotKey);
    const base = stored ?? { revision: 0, snapshot: this.emptySnapshot() };
    const room = this.createRoom(base.snapshot, base.revision, await this.readLog(), this.roomOptions());
    this.checkpointed = base.revision;
    this.sockets.clear();
    for (const ws of this.ctx.getWebSockets()) {
      const state = socketState<Presence>(ws);
      if (!state) continue;
      this.sockets.set(state.peer.clientId, ws);
      room.join(state.peer, state.ready);
    }
    this.room = room;
    return room;
  }

  private async readLog(): Promise<CommittedOp<Op>[]> {
    const entries = await this.ctx.storage.list<StoredOp<Op> | string>({ prefix: OP_PREFIX });
    const floor = (await this.ctx.storage.get<number>(LOG_FLOOR)) ?? 0;
    const ops: CommittedOp<Op>[] = [];
    for (const [key, value] of entries) {
      if (typeof value === 'string') continue; // a part, read with its head
      if (value.revision < floor) continue; // an op on a document a restore replaced
      const op = value.op ?? (JSON.parse(partKeys(key, value.parts ?? 0).map((k) => entries.get(k) as string).join('')) as Op);
      ops.push({ revision: value.revision, batchId: value.batchId, clientId: value.clientId, op });
    }
    return ops;
  }

  // ---- Edits ----

  private persist(c: CommittedOp<Op>): void {
    const key = opKey(c.revision);
    const json = JSON.stringify(c.op);
    const head: StoredOp<Op> = { revision: c.revision, batchId: c.batchId, clientId: c.clientId };
    const entries: Record<string, StoredOp<Op> | string> = {};
    if (json.length <= OP_PART) {
      entries[key] = { ...head, op: c.op };
    } else {
      const parts = Math.ceil(json.length / OP_PART);
      entries[key] = { ...head, parts };
      partKeys(key, parts).forEach((k, i) => (entries[k] = json.slice(i * OP_PART, (i + 1) * OP_PART)));
    }
    // Not awaited: the output gate keeps the ack from leaving before this is durable.
    this.ctx.storage.put(entries).catch((err) => console.error(`${this.logPrefix} logging an op failed:`, err));
  }

  /**
   * Commits an op the server made (a data refresh, an agent's write) as an
   * edit by `userId`, under `clientId`, and sends it to everyone connected.
   */
  protected commitServerOp(room: Core, op: Op, clientId: string, userId: string): ServerCommit<Op> {
    const result = room.commitServer(op, clientId);
    this.dispatch(room, result.out);
    if (room.needsReload) {
      console.error(`${this.logPrefix} a server op failed to apply; rebuilding the room from its checkpoint`);
      this.reload();
    } else if (result.committed) {
      this.edited(room, userId);
    }
    return result;
  }

  private edited(room: Core, userId: string): void {
    this.ctx.storage.put(LAST_EDITOR, userId).catch((err) => console.error(`${this.logPrefix} recording the editor failed:`, err));
    if (room.revision - this.checkpointed >= CHECKPOINT_EVERY) {
      this.checkpoint().catch((err) => console.error(`${this.logPrefix} checkpoint failed:`, err));
    } else {
      this.scheduleCheckpoint().catch((err) => console.error(`${this.logPrefix} scheduling a checkpoint failed:`, err));
    }
  }

  protected dispatch(room: Core, out: Outgoing<Op, Snapshot, Presence>[]): void {
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

  private unavailable(): string {
    return `${this.noun.charAt(0).toUpperCase()}${this.noun.slice(1)} unavailable`;
  }

  // ---- Versions ----

  private async replaceWithVersion(request: VersionRestore): Promise<RestoreOutcome> {
    const room = this.room ?? (await this.load());
    const meta = this.meta;
    if (!meta) throw new Error(`This room has not been given a ${this.noun}`);
    const version = await this.readStored(request.versionKey);
    if (!version) return { ok: false, reason: 'missing_version' };
    const restored = this.restoredFrom(version.snapshot);

    // 1. Everything so far is in the checkpoint, so stopping halfway loses nothing.
    // (A checkpoint already running may have started before the last edits.)
    while (room.revision > this.checkpointed) await this.checkpoint();
    const current = room.revision;
    const autoKey = this.versionKeyFor(meta.snapshotKey, request.autoVersionId);
    const autoSize = await this.writeStored(autoKey, current, this.snapshotOf(room));
    await this.saveAutoVersion(meta, {
      id: request.autoVersionId,
      revision: current,
      snapshotKey: autoKey,
      size: autoSize,
      createdById: request.userId,
    });

    // 2. The floor goes first: if the object stops before the new checkpoint
    // is written, it comes back as the document was, without the old log.
    const revision = current + 1;
    const floor = (await this.ctx.storage.get<number>(LOG_FLOOR)) ?? 0;
    await this.ctx.storage.put(LOG_FLOOR, revision);
    let size: number;
    try {
      size = await this.writeStored(meta.snapshotKey, revision, restored);
    } catch (err) {
      await this.ctx.storage.put(LOG_FLOOR, floor);
      throw err;
    }

    // 3. The new room takes over everyone connected, and tells them.
    const next = this.createRoom(restored, revision, [], this.roomOptions());
    for (const ws of this.sockets.values()) {
      const state = socketState<Presence>(ws);
      if (state) next.join(state.peer, state.ready);
    }
    this.room = next;
    this.loading = Promise.resolve(next);
    this.checkpointed = revision;
    const snapshot = this.snapshotOf(next);
    this.dispatch(next, [{ to: null, msg: { type: 'restored', revision, snapshot, versionId: request.versionId, userId: request.userId } }]);

    await this.ctx.storage.put(LAST_EDITOR, request.userId);
    await this.trimLog(revision - 1);
    try {
      await this.recordCheckpoint(meta, { revision, snapshotKey: meta.snapshotKey, size, userId: request.userId }, false);
      await this.afterCheckpoint(next, meta);
    } catch (err) {
      // The checkpoint itself is safe in R2; the row catches up at the next one.
      console.error(`${this.logPrefix} recording the restore failed:`, err);
    }
    return { ok: true, revision };
  }

  // ---- Checkpoints ----

  private async scheduleCheckpoint(): Promise<void> {
    if (this.alarmPending) return;
    this.alarmPending = true;
    const at = Date.now() + CHECKPOINT_DELAY_MS;
    if (this.checkpointSetsAlarm(await this.ctx.storage.getAlarm(), at)) await this.ctx.storage.setAlarm(at);
  }

  protected checkpoint(): Promise<void> {
    this.checkpointing ??= this.writeCheckpoint().finally(() => {
      this.checkpointing = null;
    });
    return this.checkpointing;
  }

  private async writeCheckpoint(): Promise<void> {
    const room = this.room;
    const meta = this.meta;
    if (!room || !meta || room.revision <= this.checkpointed) return;
    // Taken in one go, so the document and its revision agree.
    const revision = room.revision;
    const snapshot = this.snapshotOf(room);
    // Every op the snapshot contains must be in the log before the snapshot exists.
    await this.ctx.storage.sync();
    const size = await this.writeStored(meta.snapshotKey, revision, snapshot);
    this.checkpointed = revision;
    await this.trimLog(revision - KEEP_LOG);
    await this.afterCheckpoint(room, meta);
    await this.report(meta, revision, size);
    if (room.revision > this.checkpointed) await this.scheduleCheckpoint();
  }

  /** Drops logged ops up to and including `revision`. */
  private async trimLog(revision: number): Promise<void> {
    if (revision < 1) return;
    const keys = [...(await this.ctx.storage.list({ prefix: OP_PREFIX, end: opKey(revision + 1) })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }

  /** Tells the tenant DB where the checkpoint is, and everyone else that the document changed. */
  private async report(meta: Meta, revision: number, size: number): Promise<void> {
    try {
      const editor = (await this.ctx.storage.get<string>(LAST_EDITOR)) ?? null;
      await this.recordCheckpoint(meta, { revision, snapshotKey: meta.snapshotKey, size, userId: editor }, true);
    } catch (err) {
      // The checkpoint itself is safe in R2; the row catches up at the next one.
      console.error(`${this.logPrefix} recording the checkpoint failed:`, err);
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

function socketState<Presence>(ws: WebSocket): SocketState<Presence> | null {
  return (ws.deserializeAttachment() as SocketState<Presence> | null) ?? null;
}

/** Zero-padded, so storage lists ops in revision order. */
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
