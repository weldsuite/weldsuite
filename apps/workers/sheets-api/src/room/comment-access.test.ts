import { describe, expect, it } from 'vitest';
import { Engine, Sheet, Workbook, applyOp, type Op, type SheetComment } from '@weldsuite/sheets-engine';
import { isCommentersOp } from './comment-access';
import { MentionTracker, plainBody } from './mentions';

const TAB = 'sh_tab';

const comment = (over: Partial<SheetComment> = {}): SheetComment => ({
  id: 'c1',
  thread: 'c1',
  author: { id: 'ann', name: 'Ann' },
  createdAt: 1,
  body: 'Is this right?',
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
  it('their own new thread, reply and edit, and resolving anyone’s thread', () => {
    const engine = engineWith(comment());
    expect(isCommentersOp(patch([comment({ id: 'c2', thread: 'c2', author: { id: 'bo', name: 'Bo' } })]), 'bo', engine)).toBe(true);
    expect(isCommentersOp(patch([comment({ id: 'r1', thread: 'c1', author: { id: 'bo', name: 'Bo' }, cell: undefined })]), 'bo', engine)).toBe(true);
    expect(isCommentersOp(patch([comment({ resolved: true })]), 'bo', engine)).toBe(true);
    expect(isCommentersOp(patch([comment({ body: 'Edited' })]), 'ann', engine)).toBe(true);
    expect(isCommentersOp(patch(undefined, ['c1']), 'ann', engine)).toBe(true);
  });

  it('not someone else’s words, a comment in their name, or anything but comments', () => {
    const engine = engineWith(comment());
    expect(isCommentersOp(patch([comment({ body: 'Rewritten' })]), 'bo', engine)).toBe(false);
    expect(isCommentersOp(patch([comment({ resolved: true, body: 'And rewritten' })]), 'bo', engine)).toBe(false);
    expect(isCommentersOp(patch([comment({ id: 'c3', thread: 'c3' })]), 'bo', engine)).toBe(false);
    expect(isCommentersOp(patch(undefined, ['c1']), 'bo', engine)).toBe(false);
    expect(isCommentersOp({ type: 'setCells', sheetId: TAB, cells: [[0, 0, { v: 1 }]] }, 'bo', engine)).toBe(false);
    const mixed: Op = { type: 'batch', ops: [patch([comment({ id: 'c4', thread: 'c4', author: { id: 'bo', name: 'Bo' } })]), { type: 'setCells', sheetId: TAB, cells: [[0, 0, { v: 1 }]] }] };
    expect(isCommentersOp(mixed, 'bo', engine)).toBe(false);
  });
});

describe('mentions', () => {
  it('reports people a comment newly names, never its author, and nothing already known', () => {
    const tracker = new MentionTracker(engineWith(comment({ body: 'Hi @[Bo](bo)', mentions: ['bo'] })));
    expect(tracker.take(patch([comment({ body: 'Hi @[Bo](bo) and @[Cy](cy)', mentions: ['bo', 'cy', 'ann'] })]))).toEqual([
      expect.objectContaining({ tabId: TAB, userIds: ['cy'] }),
    ]);
    expect(tracker.take(patch([comment({ body: 'Again', mentions: ['bo', 'cy'] })]))).toEqual([]);
    const reply = comment({ id: 'r1', cell: undefined, author: { id: 'cy', name: 'Cy' }, body: '@[Ann](ann)', mentions: ['ann'] });
    expect(tracker.take({ type: 'batch', ops: [patch([reply]), { type: 'setCells', sheetId: TAB, cells: [] }] })).toEqual([
      expect.objectContaining({ userIds: ['ann'], comment: expect.objectContaining({ id: 'r1' }) }),
    ]);
    // Removed and written again: it names them anew.
    tracker.take(patch(undefined, ['r1']));
    expect(tracker.take(patch([reply]))).toHaveLength(1);
  });

  it('turns mention markup into names for a notification', () => {
    expect(plainBody('Thanks @[Bo Smith](user_1),   see row 3')).toBe('Thanks @Bo Smith, see row 3');
    expect(plainBody('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
