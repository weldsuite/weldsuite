/**
 * What a commenter may change: someone who can view a document and holds
 * `docs:comment`, but cannot edit it (docs/plans/welddocs.md, Access).
 *
 * Comments live inside the document and travel as ops, so the room checks a
 * commenter's ops one by one, as they would be applied (transformed and
 * validated) against the document before them. A batch passes only if every
 * op in it does:
 *
 *   - `patchComments` that sets or removes only comments whose author is the
 *     commenter (a new comment, a reply, an edit of their own), or that only
 *     flips `resolved` on a discussion's first comment, whoever wrote it;
 *   - `patchAnchors` that sets or removes only comment anchors of
 *     discussions the commenter started (their own first comment, already in
 *     the document or set by the same batch).
 *
 * Anything else (text, formatting, someone else's comment, a bookmark) is
 * refused like a viewer's edit.
 */

import { unbatch, type Anchor, type DocComment, type DocModel, type Op, type OpOf } from '@weldsuite/docs-engine';

export function isCommentersOp(op: Op, userId: string, doc: DocModel): boolean {
  const ops = unbatch(op);
  // Discussions this batch starts: their anchor may come before or after the comment.
  const started = new Set<string>();
  for (const o of ops) {
    if (o.type !== 'patchComments') continue;
    for (const c of o.set ?? []) if (c.thread === c.id && c.author.id === userId) started.add(c.id);
  }
  const ownsThread = (id: string) => {
    if (started.has(id)) return true;
    const root = doc.comments.get(id);
    return !!root && root.thread === root.id && root.author.id === userId;
  };
  return ops.every((o) => {
    if (o.type === 'patchComments') return commentsAllowed(o, userId, doc);
    if (o.type === 'patchAnchors') return anchorsAllowed(o, doc, ownsThread);
    return false;
  });
}

function commentsAllowed(op: OpOf<'patchComments'>, userId: string, doc: DocModel): boolean {
  const removable = (id: string) => {
    const old = doc.comments.get(id);
    return !old || old.author.id === userId;
  };
  return (op.set ?? []).every((c) => maySet(c, doc.comments.get(c.id), userId)) && (op.remove ?? []).every(removable);
}

function maySet(next: DocComment, old: DocComment | undefined, userId: string): boolean {
  if (old && old.thread === old.id && sameExceptResolved(old, next)) return true;
  if (next.author.id !== userId || (old && old.author.id !== userId)) return false;
  // Tying a discussion to a suggestion is part of suggesting, not commenting.
  return next.suggestion === old?.suggestion;
}

function anchorsAllowed(op: OpOf<'patchAnchors'>, doc: DocModel, ownsThread: (id: string) => boolean): boolean {
  const isOwnCommentAnchor = (a: Pick<Anchor, 'id' | 'kind'>) => a.kind === 'comment' && ownsThread(a.id);
  const settable = (a: Anchor) => {
    const old = doc.anchors.get(a.id);
    return isOwnCommentAnchor(a) && (!old || old.kind === 'comment');
  };
  const removable = (id: string) => {
    const old = doc.anchors.get(id);
    return !old || isOwnCommentAnchor(old);
  };
  return (op.set ?? []).every(settable) && (op.remove ?? []).every(removable);
}

function sameExceptResolved(a: DocComment, b: DocComment): boolean {
  return deepEqual({ ...a, resolved: undefined }, { ...b, resolved: undefined });
}

/** Plain-JSON equality; a key set to undefined counts as absent. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
