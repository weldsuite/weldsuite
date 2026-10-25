import { describe, expect, it } from 'vitest';
import { OBJECT, PARA } from '../model/chars';
import { DocModel } from '../model/document';
import { BODY, cellStoryId } from '../model/objects';
import { applyOp } from '../ops/apply';
import type { Op } from '../ops/types';
import { validateOp } from '../ops/validate';
import { counterIds, snapshotKey } from '../test-support';
import { caretAt, insertText } from './commands';
import {
  cellOf,
  cellStoryAt,
  clearCells,
  deleteDims,
  deleteTable,
  distributeColumns,
  findTable,
  formatCells,
  insertCols,
  insertRows,
  insertTable,
  mergeCells,
  resizeColumn,
  unmergeCell,
} from './tables';

function run(d: DocModel, op: Op): void {
  expect(validateOp(d, op)).toBeNull();
  applyOp(d, op);
}

function withTable(text = ''): { d: DocModel; id: string } {
  const d = DocModel.create();
  if (text) applyOp(d, { type: 'insert', story: BODY, at: 0, content: { text } });
  const edit = insertTable(d, caretAt(BODY, text.length), 2, 3, counterIds('t'));
  run(d, edit.op);
  const id = [...d.tables.keys()][0]!;
  return { d, id };
}

describe('table commands', () => {
  it('inserts a table into an empty paragraph, or after the current one', () => {
    const a = withTable();
    expect(a.d.body.text()).toBe(`${OBJECT}${PARA}`);
    const b = withTable('Intro');
    expect(b.d.body.text()).toBe(`Intro${PARA}${OBJECT}${PARA}`);
    const t = b.d.tables.get(b.id)!;
    expect(t.rows).toHaveLength(2);
    expect(t.cols).toHaveLength(3);
    expect(t.cols.reduce((n, c) => n + c.width, 0)).toBeCloseTo(451.3, 0);
    expect(findTable(b.d, b.id)).toEqual({ story: BODY, pos: 6 });
  });

  it('adds rows and columns, keeping the table’s width', () => {
    const { d, id } = withTable();
    run(d, insertRows(d, id, 1, 2, counterIds('r')));
    expect(d.tables.get(id)!.rows).toHaveLength(4);
    run(d, insertCols(d, id, 0, 1, counterIds('c')));
    const cols = d.tables.get(id)!.cols;
    expect(cols).toHaveLength(4);
    expect(cols.reduce((n, c) => n + c.width, 0)).toBeCloseTo(451.3, 0);
    const cell = cellStoryAt(d, id, 3, 3)!;
    expect(cellOf(d, cell)).toMatchObject({ tableId: id, row: 3, col: 3 });
  });

  it('merges cells, moving their text into the first, and splits them again', () => {
    const { d, id } = withTable();
    const t = d.tables.get(id)!;
    const a = cellStoryId(id, t.rows[0]!.id, t.cols[0]!.id);
    const b = cellStoryId(id, t.rows[0]!.id, t.cols[1]!.id);
    run(d, insertText(d, caretAt(a, 0), 'one').op);
    run(d, insertText(d, caretAt(b, 0), 'two').op);
    run(d, mergeCells(d, id, 0, 0, 1, 1));
    expect(d.stories.get(a)!.text()).toBe(`one${PARA}two${PARA}`);
    expect(d.stories.get(b)!.text()).toBe(PARA);
    expect(d.tables.get(id)!.cells![`${t.rows[0]!.id}:${t.cols[0]!.id}`]).toEqual({ rowSpan: 2, colSpan: 2 });
    expect(cellStoryAt(d, id, 1, 1)).toBe(a);
    run(d, unmergeCell(d, id, 1, 1));
    expect(d.tables.get(id)!.cells?.[`${t.rows[0]!.id}:${t.cols[0]!.id}`]).toBeUndefined();
  });

  it('resizes a column against its neighbour and distributes widths', () => {
    const { d, id } = withTable();
    const before = d.tables.get(id)!.cols.map((c) => c.width);
    run(d, resizeColumn(d, id, 0, 30));
    const after = d.tables.get(id)!.cols.map((c) => c.width);
    expect(after[0]).toBeCloseTo(before[0]! + 30);
    expect(after[1]).toBeCloseTo(before[1]! - 30);
    run(d, distributeColumns(d, id));
    const even = d.tables.get(id)!.cols.map((c) => c.width);
    expect(new Set(even).size).toBe(1);
  });

  it('deletes rows, columns, and the whole table when they all go', () => {
    const { d, id } = withTable('x');
    run(d, deleteDims(d, id, 'col', 1, 1));
    expect(d.tables.get(id)!.cols).toHaveLength(2);
    run(d, deleteDims(d, id, 'row', 0, 2));
    expect(d.tables.has(id)).toBe(false);
    expect(d.body.text()).toBe(`x${PARA}${PARA}`);
  });

  it('formats and clears cells, and deletes a table with undo restoring it', () => {
    const { d, id } = withTable();
    const t = d.tables.get(id)!;
    const a = cellStoryId(id, t.rows[1]!.id, t.cols[2]!.id);
    run(d, insertText(d, caretAt(a, 0), 'text').op);
    run(d, formatCells(d, id, 0, 0, 1, 2, { background: '#ff0000' }));
    expect(Object.keys(d.tables.get(id)!.cells!)).toHaveLength(6);
    run(d, clearCells(d, id, 0, 0, 1, 2));
    expect(d.stories.get(a)!.text()).toBe(PARA);
    const before = snapshotKey(d);
    const del = deleteTable(d, id);
    const inverse = applyOp(d, del);
    expect(d.tables.size).toBe(0);
    applyOp(d, inverse);
    expect(snapshotKey(d)).toBe(before);
  });
});
