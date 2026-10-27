/**
 * What a commenter may change: someone who can view a spreadsheet and holds
 * `sheets:comment`, but cannot edit it (as in WeldDocs).
 *
 * A comment's text lives in the sheet's WeldChat chat (ADR CHAT-007); the
 * workbook holds one entry per thread, saying where it is and whether it is
 * resolved, set and removed by `patchComments` ops. The room checks a
 * commenter's ops one by one, as they would be applied (transformed and
 * validated) against the workbook before them. A batch passes only if every
 * op in it is a `patchComments` that:
 *
 *   - sets only threads the commenter started (a new thread on a cell), or
 *     only flips `resolved` on a thread, whoever started it;
 *   - removes only threads the commenter started.
 *
 * Anything else (a cell, a format, moving someone else's thread) is refused
 * like a viewer's edit.
 */

import type { Engine, Op, SheetComment } from '@weldsuite/sheets-engine';

export function isCommentersOp(op: Op, userId: string, engine: Engine): boolean {
  const ops = op.type === 'batch' ? op.ops : [op];
  return ops.every((o) => {
    if (o.type !== 'patchComments') return false;
    const sheet = engine.workbook.getSheet(o.sheetId);
    if (!sheet) return false;
    const existing = new Map(sheet.comments.map((c) => [c.id, c]));
    const removable = (id: string) => {
      const old = existing.get(id);
      return !old || old.authorId === userId;
    };
    return (o.set ?? []).every((c) => maySet(c, existing.get(c.id), userId)) && (o.remove ?? []).every(removable);
  });
}

function maySet(next: SheetComment, old: SheetComment | undefined, userId: string): boolean {
  if (old && sameExceptResolved(old, next)) return true;
  return next.authorId === userId && (!old || old.authorId === userId);
}

function sameExceptResolved(a: SheetComment, b: SheetComment): boolean {
  return (
    a.authorId === b.authorId &&
    a.createdAt === b.createdAt &&
    a.cell?.row === b.cell?.row &&
    a.cell?.col === b.cell?.col
  );
}
