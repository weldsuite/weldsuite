/**
 * BoardRoom: one Durable Object per board (named `${workspaceId}:${boardId}`),
 * the single place a board's edits are ordered (weldsuite-documentation/plans/weldboard.md, ADR
 * BOARD-003).
 *
 * Sockets, the op log, checkpoints and version restores are `CollabRoom`
 * from @weldsuite/collab (see there), run on the board engine's adapter, as
 * for DocRoom and SheetRoom. This class adds what is particular to boards:
 *
 *   - Checkpoints and versions are `{ revision, board }` objects in R2
 *     (snapshot.ts), with a fresh SVG thumbnail next to the checkpoint. The
 *     tenant DB's `boards` row records each checkpoint, and a `board.updated`
 *     entity event reports the change.
 *   - Server writes (`applyOps`): an op made on the server (the legacy
 *     whiteboard API, an agent tool, an AI action) is committed like a
 *     client's and sent to everyone connected, so nobody races a checkpoint.
 *   - Commenters (`canComment`) may only commit comment pins, and nobody
 *     votes in another person's name (comment-access.ts).
 *
 * The class is abstract over its tenant database: each host subclasses it
 * with `tenantDb`. board-api opens Neon through worker-kit (Global);
 * collab-rooms opens CloudNativePG on Node (the Kubernetes editions). Nothing
 * here imports worker-kit, which goes with the workers (ADR OPS-025).
 */

import { CollabRoom, type AdmittedPeer, type AutoVersion, type CheckpointRecord, type RestoreOutcome, type VersionRestore } from '@weldsuite/collab/durable-room';
import { RoomCore, type CommittedOp, type RoomOptions } from '@weldsuite/collab';
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
import { publishEntityEventRaw, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import type { TenantDb } from '@weldsuite/db/lib/any-db';
import { recordCheckpoint } from '../services/boards';
import { insertVersion, versionKeyFor } from '../services/versions';
import { readSnapshot, writeSnapshot, writeThumbnail } from './snapshot';
import { isCommentersOp, votesAreSenders } from './comment-access';

export { replyCode } from '@weldsuite/collab/durable-room';
export type { LiveSnapshot, RestoreOutcome, SavedVersion } from '@weldsuite/collab/durable-room';

type BoardRoomCore = RoomCore<Board, Op, BoardSnapshot, BoardPresence>;

/** The bindings a room reads, whichever host runs it. */
export interface BoardRoomEnv extends EntityEventPublisherEnv {
  /** Board checkpoints and thumbnails (private bucket, `workspaces/<org>/boards/<id>/…`). */
  PRIVATE_STORAGE: R2Bucket;
}

/** Which board a room holds, and where its checkpoint is. */
export interface RoomMeta {
  /** Clerk org id (what worker-kit calls the workspace id). */
  workspaceId: string;
  boardId: string;
  snapshotKey: string;
}

/**
 * What the session route tells the room: which board it is, and who is
 * coming in (`canComment`: may add comment pins without editing, ignored
 * when `canEdit`).
 */
export interface Admission extends RoomMeta, AdmittedPeer {
  picture: string | null;
  canComment: boolean;
}

export interface RestoreRequest extends VersionRestore {
  board: RoomMeta;
}

/** What a server write did. `refused` says why it was not committed. */
export interface ServerWriteResult {
  revision: number;
  committed: boolean;
  refused?: string;
}

/** A thumbnail draws at most this many elements (the rest of a huge board is not worth the bytes). */
const THUMBNAIL_ELEMENTS = 1500;

const thumbnailMeasurer = new CachedMeasurer(new MetricsMeasurer(), 50_000);

/** Shape checks only (ops and presence from a browser): the board does not matter here. */
const shapeChecks = boardAdapter();

export abstract class BoardRoom<E extends BoardRoomEnv = BoardRoomEnv> extends CollabRoom<E, RoomMeta, Board, Op, BoardSnapshot, BoardPresence> {
  protected readonly logPrefix = '[board-api/room]';
  protected readonly noun = 'board';
  protected readonly shapeChecks = shapeChecks;

  /** The tenant database of `workspaceId` (the room meta's, a Clerk org id or `workspaces.id`). */
  protected abstract tenantDb(workspaceId: string): Promise<TenantDb>;

  /** Registers a ticket for one connection (RPC from the session route). */
  async admit(admission: Admission): Promise<string> {
    const { workspaceId, boardId, snapshotKey, ...peer } = admission;
    return this.issueTicket({ workspaceId, boardId, snapshotKey }, peer);
  }

  /** Replaces the board with a saved version (RPC from the restore route; see `restoreTo`). */
  async restoreVersion(req: RestoreRequest): Promise<RestoreOutcome> {
    return this.restoreTo(req.board, req);
  }

  /** The board as plain text (search, AI, agents). */
  async plainText(board: RoomMeta): Promise<string> {
    const room = await this.roomFor(board);
    return boardToPlainText(room.state);
  }

  /**
   * Commits an op made on the server, as `userId`, against the current
   * revision, and sends it to everyone connected (RPC from BoardsInternal and
   * the AI and task routes). Callers build the op on a fresh `snapshot()`.
   */
  async applyOps(board: RoomMeta, op: Op, userId: string): Promise<ServerWriteResult> {
    const room = await this.roomFor(board);
    const result = this.commitServerOp(room, op, `server:${userId}`, userId);
    if (room.needsReload) return { revision: room.revision, committed: false, refused: result.refused ?? 'the op failed to apply' };
    return { revision: room.revision, committed: !!result.committed, ...(result.refused ? { refused: result.refused } : {}) };
  }

  // ---- The board ----

  protected createRoom(snapshot: BoardSnapshot, revision: number, ops: CommittedOp<Op>[], options: RoomOptions<Op, Board, BoardPresence>): BoardRoomCore {
    return RoomCore.restore(boardAdapter(), snapshot, revision, ops, options);
  }

  protected emptySnapshot(): BoardSnapshot {
    return emptySnapshot();
  }

  protected snapshotOf(room: BoardRoomCore): BoardSnapshot {
    return room.state.toSnapshot();
  }

  /** What the engine makes of a saved version. */
  protected restoredFrom(version: BoardSnapshot): BoardSnapshot {
    return Board.fromSnapshot(version).toSnapshot();
  }

  protected accessRules(): Pick<RoomOptions<Op, Board, BoardPresence>, 'mayComment' | 'mayCommit'> {
    return {
      mayComment: (op, peer, board) => isCommentersOp(op, peer.userId, board),
      mayCommit: (op, peer) => votesAreSenders(op, peer.userId),
    };
  }

  /** A small SVG of the board next to each checkpoint, for the home page and WeldDrive. */
  protected async afterCheckpoint(room: BoardRoomCore, meta: RoomMeta): Promise<void> {
    await this.thumbnail(room.state, meta).catch((err) => console.error('[board-api/room] thumbnail failed:', err));
  }

  private async thumbnail(board: Board, meta: RoomMeta): Promise<void> {
    const ids = board.paintOrder().slice(0, THUMBNAIL_ELEMENTS).map((e) => e.id);
    const only = new Set(ids);
    const view = selectionBounds(board, only);
    if (!view) return;
    const svg = displayToSvg(boardDisplay(board, { measurer: thumbnailMeasurer }, only), { view, width: 480, padding: 32, background: '#f7f8fa' });
    await writeThumbnail(this.env.PRIVATE_STORAGE, meta.snapshotKey, svg);
  }

  // ---- Storage and the tenant DB ----

  protected async readStored(key: string): Promise<{ revision: number; snapshot: BoardSnapshot } | null> {
    const stored = await readSnapshot(this.env.PRIVATE_STORAGE, key);
    return stored && { revision: stored.revision, snapshot: stored.board };
  }

  protected writeStored(key: string, revision: number, board: BoardSnapshot): Promise<number> {
    return writeSnapshot(this.env.PRIVATE_STORAGE, key, { revision, board });
  }

  protected versionKeyFor(snapshotKey: string, versionId: string): string {
    return versionKeyFor(snapshotKey, versionId);
  }

  protected async saveAutoVersion(meta: RoomMeta, version: AutoVersion): Promise<void> {
    const db = await this.tenantDb(meta.workspaceId);
    await insertVersion(db, { ...version, boardId: meta.boardId, name: null });
  }

  protected async recordCheckpoint(meta: RoomMeta, checkpoint: CheckpointRecord, announce: boolean): Promise<void> {
    const db = await this.tenantDb(meta.workspaceId);
    const board = await recordCheckpoint(db, meta.boardId, checkpoint);
    const editor = checkpoint.userId;
    if (!announce || !board || !editor || editor.startsWith('server:')) return;
    await publishEntityEventRaw({
      env: this.env,
      workspaceId: meta.workspaceId,
      userId: editor,
      entityType: 'board',
      action: 'updated',
      entityId: board.id,
      data: { id: board.id, fileId: board.fileId, name: board.name, projectId: board.projectId, revision: checkpoint.revision, updatedById: editor },
      source: 'web',
    });
  }
}
