import { describe, expect, it } from 'vitest';
import { cellSelection, contextMenuSelection, wholeColumns, wholeRows } from './selection';

describe('contextMenuSelection', () => {
  const a1 = cellSelection(0, 0);

  it('selects the whole row under a row header, so the menu inserts around that row', () => {
    const next = contextMenuSelection(a1, { area: 'rowHeader', row: 1, col: 0 });
    expect(next?.ranges).toEqual([wholeRows(1, 1)]);
    expect(next?.active).toEqual({ row: 1, col: 0 });
  });

  it('selects the whole column under a column header', () => {
    const next = contextMenuSelection(a1, { area: 'colHeader', row: 0, col: 3 });
    expect(next?.ranges).toEqual([wholeColumns(3, 3)]);
    expect(next?.active).toEqual({ row: 0, col: 3 });
  });

  it('keeps rows or columns that are already selected as a whole', () => {
    const rows = { ranges: [wholeRows(1, 4)], active: { row: 1, col: 0 }, anchor: { row: 1, col: 0 } };
    expect(contextMenuSelection(rows, { area: 'rowHeader', row: 3, col: 0 })).toBeNull();
    const cols = { ranges: [wholeColumns(2, 5)], active: { row: 0, col: 2 }, anchor: { row: 0, col: 2 } };
    expect(contextMenuSelection(cols, { area: 'colHeader', row: 0, col: 5 })).toBeNull();
  });

  it('selects a cell outside the selection and keeps one inside it', () => {
    expect(contextMenuSelection(a1, { area: 'cell', row: 2, col: 2 })).toEqual(cellSelection(2, 2));
    expect(contextMenuSelection(a1, { area: 'cell', row: 0, col: 0 })).toBeNull();
  });

  it('leaves the selection alone on the corner', () => {
    expect(contextMenuSelection(a1, { area: 'corner', row: 0, col: 0 })).toBeNull();
  });
});
