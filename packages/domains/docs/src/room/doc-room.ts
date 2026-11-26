/**
 * DocRoom: one Durable Object per document (named `${workspaceId}:${docId}`),
 * the single place a document's edits are ordered (weldsuite-documentation/plans/welddocs.md).
 *
 * Sockets, the op log, checkpoints and version restores are `CollabRoom`
 * from @weldsuite/collab (see there), run on the docs engine's adapter. This
 * class adds what is particular to documents:
 *
 *   - Checkpoints and versions are `{ revision, doc }` objects in R2
 *     (snapshot.ts); the tenant DB's `docs` row records each checkpoint, and
 *     a `doc.updated` entity event reports the change.
 *   - Commenters (`canComment`) may only commit comment ops (comment-access.ts).
 */

import { CollabRoom, type AdmittedPeer, type AutoVersion, type CheckpointRecord, type RestoreOutcome, type VersionRestore } from '@weldsuite/collab/durable-room';
import { RoomCore, type CommittedOp, type RoomOptions } from '@weldsuite/collab';
import { DocModel, docsAdapter, type DocPresence, type DocSnapshot, type Op } from '@weldsuite/docs-engine';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { recordCheckpoint } from '../services/docs';
import { insertVersion, versionKeyFor } from '../services/versions';
import { readSnapshot, writeSnapshot } from './snapshot';
import { isCommentersOp } from './comment-access';

export { replyCode } from '@weldsuite/collab/durable-room';
export type { LiveSnapshot, RestoreOutcome, SavedVersion } from '@weldsuite/collab/durable-room';

/** Which document a room holds, and where its checkpoint is. */
export interface RoomMeta {
  /** Clerk org id (what worker-kit calls the workspace id). */
  workspaceId: string;
  docId: string;
  snapshotKey: string;
}

/**
 * What the session route tells the room: which document it is, and who is
 * coming in (`canComment`: may add comments without editing, ignored when
 * `canEdit`).
 */
export interface Admission extends RoomMeta, AdmittedPeer {
  picture: string | null;
  canComment: boolean;
}

/** What the restore route asks the room. */
export interface RestoreRequest extends VersionRestore {
  doc: RoomMeta;
}

/** Shape checks only (ops and presence from a browser): the document does not matter here. */
const shapeChecks = docsAdapter();

export class DocRoom extends CollabRoom<Env, RoomMeta, DocModel, Op, DocSnapshot, DocPresence> {
  protected readonly logPrefix = '[docs-api/room]';
  protected readonly noun = 'document';
  protected readonly shapeChecks = shapeChecks;

  /** Registers a ticket for one connection (RPC from the session route). */
  async admit(admission: Admission): Promise<string> {
    const { workspaceId, docId, snapshotKey, ...peer } = admission;
    return this.issueTicket({ workspaceId, docId, snapshotKey }, peer);
  }

  /** Replaces the document with a saved version (RPC from the restore route; see `restoreTo`). */
  async restoreVersion(req: RestoreRequest): Promise<RestoreOutcome> {
    return this.restoreTo(req.doc, req);
  }

  protected createRoom(snapshot: DocSnapshot, revision: number, ops: CommittedOp<Op>[], options: RoomOptions<Op, DocModel, DocPresence>) {
    return RoomCore.restore(docsAdapter(), snapshot, revision, ops, options);
  }

  protected emptySnapshot(): DocSnapshot {
    return DocModel.create().toSnapshot();
  }

  protected snapshotOf(room: RoomCore<DocModel, Op, DocSnapshot, DocPresence>): DocSnapshot {
    return room.state.toSnapshot();
  }

  /** What the engine makes of a saved version, as when a document is created. */
  protected restoredFrom(version: DocSnapshot): DocSnapshot {
    return DocModel.fromSnapshot(version).toSnapshot();
  }

  protected accessRules(): Pick<RoomOptions<Op, DocModel, DocPresence>, 'mayComment'> {
    return { mayComment: (op, peer, doc) => isCommentersOp(op, peer.userId, doc) };
  }

  protected async readStored(key: string): Promise<{ revision: number; snapshot: DocSnapshot } | null> {
    const stored = await readSnapshot(this.env.PRIVATE_STORAGE, key);
    return stored && { revision: stored.revision, snapshot: stored.doc };
  }

  protected writeStored(key: string, revision: number, doc: DocSnapshot): Promise<number> {
    return writeSnapshot(this.env.PRIVATE_STORAGE, key, { revision, doc });
  }

  protected versionKeyFor(snapshotKey: string, versionId: string): string {
    return versionKeyFor(snapshotKey, versionId);
  }

  protected async saveAutoVersion(meta: RoomMeta, version: AutoVersion): Promise<void> {
    const db = await getTenantDbForWorkspace(this.env, meta.workspaceId);
    await insertVersion(db, { ...version, docId: meta.docId, name: null });
  }

  protected async recordCheckpoint(meta: RoomMeta, checkpoint: CheckpointRecord, announce: boolean): Promise<void> {
    const db = await getTenantDbForWorkspace(this.env, meta.workspaceId);
    const doc = await recordCheckpoint(db, meta.docId, checkpoint);
    const editor = checkpoint.userId;
    if (!announce || !doc || !editor) return;
    await publishEntityEventRaw({
      env: this.env,
      workspaceId: meta.workspaceId,
      userId: editor,
      entityType: 'doc',
      action: 'updated',
      entityId: doc.id,
      data: { id: doc.id, fileId: doc.fileId, name: doc.name, revision: checkpoint.revision, updatedById: editor },
      source: 'web',
    });
  }
}
