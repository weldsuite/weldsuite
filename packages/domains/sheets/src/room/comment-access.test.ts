import { describe, expect, it } from 'vitest';
import { Engine, Sheet, Workbook, applyOp, type Op, type SheetComment } from '@weldsuite/sheets-engine';
import { isCommentersOp } from './comment-access';

const TAB = 'sh_tab';

const comment = (over: Partial<SheetComment> = {}): SheetComment => ({
  id: 'c1',
  authorId: 'ann',
  createdAt: 1,
  cell: { row: 1, col: 1 },
  ...over,
});

function engineWith(...comments: SheetComment[]): Engine {
  const wb = new Workbook();
  wb.sheets.push(new Sheet(TAB, 'Sheet1'));
  const engine = new Engine(wb);
  if (comments.length) applyOp(engine, { type: 'patchComments', sheetId: TAB, set: comments });
  return engine;
}

const patch = (set?: SheetComment[], remove?: string[]): Op => ({ type: 'patchComments', sheetId: TAB, ...(set ? { set } : {}), ...(remove ? { remove } : {}) });

describe('what a commenter may commit', () => {
  it('their own new thread, moving or removing it, and resolving anyone’s thread', () => {
    const engine = engineWith(comment());
    expect(isCommentersOp(patch([comment({ id: 'c2', authorId: 'bo' })]), 'bo', engine)).toBe(true);
    expect(isCommentersOp(patch([comment({ resolved: true })]), 'bo', engine)).toBe(true);
    expect(isCommentersOp(patch([comment({ cell: { row: 5, col: 1 } })]), 'ann', engine)).toBe(true);
    expect(isCommentersOp(patch(undefined, ['c1']), 'ann', engine)).toBe(true);
  });

  it('not someone else’s thread, a thread in their name, or anything but comments', () => {
    const engine = engineWith(comment());
    expect(isCommentersOp(patch([comment({ cell: { row: 5, col: 1 } })]), 'bo', engine)).toBe(false);
    expect(isCommentersOp(patch([comment({ resolved: true, cell: { row: 5, col: 1 } })]), 'bo', engine)).toBe(false);
    expect(isCommentersOp(patch([comment({ id: 'c3' })]), 'bo', engine)).toBe(false);
    expect(isCommentersOp(patch([comment({ authorId: 'bo' })]), 'bo', engine)).toBe(false);
    expect(isCommentersOp(patch(undefined, ['c1']), 'bo', engine)).toBe(false);
    expect(isCommentersOp({ type: 'setCells', sheetId: TAB, cells: [[0, 0, { v: 1 }]] }, 'bo', engine)).toBe(false);
    const mixed: Op = { type: 'batch', ops: [patch([comment({ id: 'c4', authorId: 'bo' })]), { type: 'setCells', sheetId: TAB, cells: [[0, 0, { v: 1 }]] }] };
    expect(isCommentersOp(mixed, 'bo', engine)).toBe(false);
  });
});
