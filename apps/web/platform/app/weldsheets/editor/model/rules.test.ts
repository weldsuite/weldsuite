import { describe, expect, it, vi } from 'vitest';
import { EN_LOCALE } from '@weldsuite/sheets-engine';
import { handleEditKey, handleGridKey } from './keyboard';
import {
  currentRegion,
  filterValues,
  moveFormat,
  saveFormat,
  saveValidation,
  setFilterColumn,
  sortByColumn,
  subtractRange,
  toggleFilter,
} from './rules';
import { cellSelection } from './selection';
import { SheetController } from './sheet-controller';

function make() {
  const onInputRefused = vi.fn();
  const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' }, onInputRefused });
  // B2:C6 with a header row, and a stray value in E9.
  const rows = [
    ['Fruit', 'Qty'],
    ['Pear', '12'],
    ['Apple', '5'],
    ['Pear', '7'],
    ['', '3'],
  ];
  rows.forEach((cells, r) => cells.forEach((text, c) => text && ctl.setInput(r + 1, c + 1, text)));
  ctl.setInput(8, 4, 'x');
  return { ctl, onInputRefused };
}

const value = (ctl: SheetController, row: number, col: number) => ctl.engine.getValue(ctl.activeSheetId, row, col);
const key = (k: string) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });

describe('filters from the editor', () => {
  it('takes the block of data around the active cell', () => {
    const { ctl } = make();
    expect(currentRegion(ctl, 3, 2)).toEqual({ r1: 1, c1: 1, r2: 5, c2: 2 });
    expect(currentRegion(ctl, 8, 4)).toEqual({ r1: 8, c1: 4, r2: 8, c2: 4 });
  });

  it('creates a filter, lists values, hides rows and removes it again', () => {
    const { ctl } = make();
    ctl.select(cellSelection(2, 1));
    toggleFilter(ctl);
    expect(ctl.sheet.filter?.range).toEqual({ r1: 1, c1: 1, r2: 5, c2: 2 });
    expect(filterValues(ctl, 1)).toEqual([
      { key: 's:Apple', label: 'Apple', count: 1 },
      { key: 's:Pear', label: 'Pear', count: 2 },
      { key: '', label: '', count: 1 },
    ]);
    setFilterColumn(ctl, 1, { hiddenValues: ['s:Pear'] });
    expect([2, 3, 4, 5].filter((r) => ctl.sheet.rows.isFiltered(r))).toEqual([2, 4]);
    setFilterColumn(ctl, 2, { condition: { type: 'greater', value: 4 } });
    expect([2, 3, 4, 5].filter((r) => ctl.sheet.rows.isFiltered(r))).toEqual([2, 4, 5]);
    setFilterColumn(ctl, 1, null);
    expect(ctl.sheet.filter?.columns.map((c) => c.col)).toEqual([2]);
    toggleFilter(ctl);
    expect(ctl.sheet.filter).toBeNull();
    expect([2, 3, 4, 5].filter((r) => ctl.sheet.rows.isFiltered(r))).toEqual([]);
  });

  it('sorts the filter range below its header', () => {
    const { ctl } = make();
    ctl.select(cellSelection(2, 1));
    toggleFilter(ctl);
    expect(sortByColumn(ctl, 2, true)).toBeNull();
    expect([1, 2, 3, 4, 5].map((r) => value(ctl, r, 2))).toEqual(['Qty', 12, 7, 5, 3]);
    expect([1, 2, 3, 4, 5].map((r) => value(ctl, r, 1))).toEqual(['Fruit', 'Pear', 'Pear', 'Apple', null]);
    ctl.undo();
    expect([1, 2, 3, 4, 5].map((r) => value(ctl, r, 2))).toEqual(['Qty', 12, 5, 7, 3]);
  });
});

describe('rules from the editor', () => {
  it('refuses typed values a strict rule does not allow', () => {
    const { ctl, onInputRefused } = make();
    saveValidation(ctl, { id: 'v1', ranges: [{ r1: 2, c1: 1, r2: 5, c2: 1 }], criteria: { type: 'list', values: ['Apple', 'Pear'] }, strict: true });
    ctl.setInput(2, 1, 'Plum');
    expect(onInputRefused).toHaveBeenCalledOnce();
    expect(value(ctl, 2, 1)).toBe('Pear');
    ctl.setInput(2, 1, 'apple');
    expect(value(ctl, 2, 1)).toBe('apple');
  });

  it('keeps a refused edit open to be corrected', () => {
    const { ctl, onInputRefused } = make();
    saveValidation(ctl, { id: 'v1', ranges: [{ r1: 2, c1: 1, r2: 5, c2: 1 }], criteria: { type: 'list', values: ['Apple', 'Pear'] }, strict: true });
    ctl.select(cellSelection(2, 1));
    ctl.beginEdit({ text: 'Plum' });
    expect(handleEditKey(ctl, key('Enter'))).toBe(true);
    expect(onInputRefused).toHaveBeenCalledOnce();
    expect(ctl.editing).toMatchObject({ row: 2, col: 1, text: 'Plum', replace: false });
    expect(ctl.selection.active).toEqual({ row: 2, col: 1 });
    ctl.updateEdit('Apple');
    handleEditKey(ctl, key('Enter'));
    expect(ctl.editing).toBeNull();
    expect(value(ctl, 2, 1)).toBe('Apple');
    expect(ctl.selection.active).toEqual({ row: 3, col: 1 });
  });

  it('marks values a lenient rule does not allow', () => {
    const { ctl } = make();
    saveValidation(ctl, { id: 'v1', ranges: [{ r1: 2, c1: 2, r2: 5, c2: 2 }], criteria: { type: 'condition', condition: { type: 'greater', value: 6 } }, strict: false });
    ctl.setInput(3, 2, '1');
    expect(value(ctl, 3, 2)).toBe(1);
    expect(ctl.isInvalid(3, 2)).toBe(true);
    expect(ctl.isInvalid(2, 2)).toBe(false);
  });

  it('gives a cell to the newest rule, trimming the older one', () => {
    const { ctl } = make();
    saveValidation(ctl, { id: 'old', ranges: [{ r1: 0, c1: 0, r2: 9, c2: 3 }], criteria: { type: 'checkbox' }, strict: false });
    saveValidation(ctl, { id: 'new', ranges: [{ r1: 2, c1: 1, r2: 3, c2: 2 }], criteria: { type: 'list', values: ['a'] }, strict: false });
    const old = ctl.sheet.validations.find((v) => v.id === 'old')!;
    expect(old.ranges).toEqual(subtractRange({ r1: 0, c1: 0, r2: 9, c2: 3 }, { r1: 2, c1: 1, r2: 3, c2: 2 }));
    expect(ctl.validationAt(2, 1)?.id).toBe('new');
    expect(ctl.validationAt(0, 0)?.id).toBe('old');
  });

  it('ticks checkboxes by click or Space', () => {
    const { ctl } = make();
    saveValidation(ctl, { id: 'c', ranges: [{ r1: 10, c1: 0, r2: 10, c2: 0 }], criteria: { type: 'checkbox' }, strict: true });
    ctl.toggleCheckbox(10, 0);
    expect(value(ctl, 10, 0)).toBe(true);
    ctl.select(cellSelection(10, 0));
    expect(handleGridKey(ctl, key(' '), 10)).toBe(true);
    expect(value(ctl, 10, 0)).toBe(false);
    ctl.select(cellSelection(11, 0));
    expect(handleGridKey(ctl, key(' '), 10)).toBe(false);
  });

  it('styles cells through conditional formats, first rule first', () => {
    const { ctl } = make();
    saveFormat(ctl, { id: 'a', order: 1, ranges: [{ r1: 2, c1: 2, r2: 5, c2: 2 }], rule: { type: 'condition', condition: { type: 'greater', value: 10 }, style: { bold: true } } });
    saveFormat(ctl, { id: 'b', order: 2, ranges: [{ r1: 2, c1: 2, r2: 5, c2: 2 }], rule: { type: 'condition', condition: { type: 'notEmpty' }, style: { italic: true } } });
    expect(ctl.conditionalStyle(2, 2)).toEqual({ bold: true });
    expect(ctl.conditionalStyle(3, 2)).toEqual({ italic: true });
    moveFormat(ctl, 'b', -1);
    expect(ctl.sheet.conditionalFormats.map((cf) => cf.id)).toEqual(['b', 'a']);
    expect(ctl.conditionalStyle(2, 2)).toEqual({ italic: true });
  });
});

describe('subtractRange', () => {
  it('cuts a hole into up to four pieces, or leaves a range alone', () => {
    expect(subtractRange({ r1: 0, c1: 0, r2: 4, c2: 4 }, { r1: 1, c1: 1, r2: 2, c2: 2 })).toEqual([
      { r1: 0, c1: 0, r2: 0, c2: 4 },
      { r1: 3, c1: 0, r2: 4, c2: 4 },
      { r1: 1, c1: 0, r2: 2, c2: 0 },
      { r1: 1, c1: 3, r2: 2, c2: 4 },
    ]);
    expect(subtractRange({ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 0, c1: 0, r2: 5, c2: 5 })).toEqual([]);
    expect(subtractRange({ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 3, c1: 3, r2: 5, c2: 5 })).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
  });
});
