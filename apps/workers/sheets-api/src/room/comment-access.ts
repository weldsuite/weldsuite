/**
 * What a commenter may change: someone who can view a spreadsheet and holds
 * `sheets:comment`, but cannot edit it (as in WeldDocs).
 *
 * Comments live inside the workbook and travel as `patchComments` ops, so the
 * room checks a commenter's ops one by one, as they would be applied
 * (transformed and validated) against the workbook before them. A batch
 * passes only if every op in it is a `patchComments` that:
 *
 *   - sets only comments whose author is the commenter (a new thread on a
 *     cell, a reply, an edit of their own), or only flips `resolved` on a
 *     thread's first comment, whoever wrote it;
 *   - removes only the commenter's own comments.
 *
 * Anything else (a cell, a format, someone else's comment) is refused like a
 * viewer's edit.
 */

import { isThreadStart, type Engine, type Op, type SheetComment } from '@weldsuite/sheets-engine';

export function isCommentersOp(op: Op, userId: string, engine: Engine): boolean {
  const ops = op.type === 'batch' ? op.ops : [op];
  return ops.every((o) => {
    if (o.type !== 'patchComments') return false;
    const sheet = engine.workbook.getSheet(o.sheetId);
    if (!sheet) return false;
    const existing = new Map(sheet.comments.map((c) => [c.id, c]));
    const removable = (id: string) => {
      const old = existing.get(id);
      return !old || old.author.id === userId;
    };
    return (o.set ?? []).every((c) => maySet(c, existing.get(c.id), userId)) && (o.remove ?? []).every(removable);
  });
}

function maySet(next: SheetComment, old: SheetComment | undefined, userId: string): boolean {
  if (old && isThreadStart(old) && sameExceptResolved(old, next)) return true;
  return next.author.id === userId && (!old || old.author.id === userId);
}

function sameExceptResolved(a: SheetComment, b: SheetComment): boolean {
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
