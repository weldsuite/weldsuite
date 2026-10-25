/**
 * WeldDocs as a document for @weldsuite/collab: the document model is the
 * state, a document snapshot the snapshot, and the ops are the engine's own.
 */

import { CollabClient, RoomCore, type ClientMessage, type CollabClientOptions, type CommittedOp, type OtAdapter, type Peer, type RoomOptions, type ServerMessage } from '@weldsuite/collab';
import { DocModel, type DocSnapshot } from '../model/document';
import { applyOp } from '../ops/apply';
import { isWellFormedOp } from '../ops/shape';
import { transform } from '../ops/transform';
import { batch, normalize, unbatch, type Op } from '../ops/types';
import { validateOp } from '../ops/validate';

/** Where someone is in the document, shown to everyone else. Never persisted. */
export interface DocPresence {
  story: string;
  /** Where the selection started; equal to `head` for a caret. */
  anchor: number;
  /** Where the caret is. */
  head: number;
  /** True while they are typing (an IME composition, or keys in the last second). */
  typing?: boolean;
}

export type DocsAdapter = OtAdapter<DocModel, Op, DocSnapshot, DocPresence>;

export function docsAdapter(): DocsAdapter {
  return {
    load: (snapshot) => DocModel.fromSnapshot(snapshot),
    snapshot: (doc) => doc.toSnapshot(),
    apply: (doc, op) => applyOp(doc, op),
    transform: (a, b, aWins) => transform(a, b, aWins),
    normalize: (op) => normalize(op),
    batch: (ops) => batch(ops),
    unbatch: (op) => unbatch(op),
    isWellFormedOp: (v): v is Op => isWellFormedOp(v),
    validate: (doc, op) => validateOp(doc, op),
    isPresence,
  };
}

export type DocRoomOptions = RoomOptions<Op>;
export type DocClientOptions = CollabClientOptions<DocModel, Op, DocPresence>;

/** A document's room: wrap it in the DocRoom Durable Object. */
export function createDocRoom(snapshot: DocSnapshot, revision: number, options: DocRoomOptions = {}): RoomCore<DocModel, Op, DocSnapshot, DocPresence> {
  return new RoomCore(docsAdapter(), snapshot, revision, options);
}

export function restoreDocRoom(
  snapshot: DocSnapshot,
  snapshotRevision: number,
  ops: CommittedOp<Op>[],
  options: DocRoomOptions = {},
): RoomCore<DocModel, Op, DocSnapshot, DocPresence> {
  return RoomCore.restore(docsAdapter(), snapshot, snapshotRevision, ops, options);
}

export function createDocClient(options: DocClientOptions): CollabClient<DocModel, Op, DocSnapshot, DocPresence> {
  return new CollabClient(docsAdapter(), options);
}

const MAX_STORY_ID = 600;

function isPresence(v: unknown): v is DocPresence {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.story === 'string' &&
    p.story.length > 0 &&
    p.story.length <= MAX_STORY_ID &&
    Number.isInteger(p.anchor) &&
    (p.anchor as number) >= 0 &&
    Number.isInteger(p.head) &&
    (p.head as number) >= 0 &&
    (p.typing === undefined || typeof p.typing === 'boolean') &&
    Object.keys(p).every((k) => k === 'story' || k === 'anchor' || k === 'head' || k === 'typing')
  );
}

export type DocPeer = Peer<DocPresence>;
export type DocClientMessage = ClientMessage<Op, DocPresence>;
export type DocServerMessage = ServerMessage<Op, DocSnapshot, DocPresence>;
export type DocCommittedOp = CommittedOp<Op>;
