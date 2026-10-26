import { describe, expect, it } from 'vitest';
import { EN_LOCALE } from '@weldsuite/sheets-engine';
import { fittedHeight, fittedWidth, fitToData } from '../grid/autofit';
import { copySelection, moveCells, pasteInto } from './clipboard';
import { findMatches, replaceMatches, type FindOptions } from './find';
import { handleGridKey, type KeyInput } from './keyboard';
import { cellSelection, wholeColumns } from './selection';
import { SheetController } from './sheet-controller';

const make = () => new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
const value = (ctl: SheetController, row: number, col: number) => ctl.engine.getValue(ctl.activeSheetId, row, col);
const opts = (o: Partial<FindOptions> = {}): FindOptions => ({ matchCase: false, wholeCell: false, formulas: false, allSheets: false, ...o });
const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, shiftKey: false, ctrlKey: true, metaKey: false, altKey: false, ...mods });

describe('find and replace', () => {
  it('finds by what cells show, in order, with options', () => {
    const ctl = make();
    ctl.setInput(2, 0, 'Apple pie');
    ctl.setInput(0, 1, 'apple');
    ctl.setInput(1, 0, '=UPPER("apple")');
    ctl.setInput(3, 0, 'banana');
    expect(findMatches(ctl, 'apple', opts())).toEqual([
      { sheetId: ctl.activeSheetId, row: 0, col: 1 },
      { sheetId: ctl.activeSheetId, row: 1, col: 0 },
      { sheetId: ctl.activeSheetId, row: 2, col: 0 },
    ]);
    expect(findMatches(ctl, 'apple', opts({ matchCase: true })).map((m) => m.row)).toEqual([0]);
    expect(findMatches(ctl, 'apple', opts({ wholeCell: true })).map((m) => m.row)).toEqual([0, 1]);
    expect(findMatches(ctl, 'UPPER', opts({ formulas: true })).map((m) => m.row)).toEqual([1]);
    expect(findMatches(ctl, 'UPPER', opts())).toEqual([]);
  });

  it('searches other sheets after the active one', () => {
    const ctl = make();
    const first = ctl.activeSheetId;
    ctl.setInput(0, 0, 'x');
    ctl.addSheet();
    ctl.setInput(5, 5, 'x');
    expect(findMatches(ctl, 'x', opts()).map((m) => m.sheetId)).toEqual([ctl.activeSheetId]);
    expect(findMatches(ctl, 'x', opts({ allSheets: true })).map((m) => m.sheetId)).toEqual([ctl.activeSheetId, first]);
  });

  it('replaces in typed values, formulas only when searched, in one undo step', () => {
    const ctl = make();
    ctl.setInput(0, 0, 'red car');
    ctl.setInput(1, 0, 'Red bus');
    ctl.setInput(2, 0, '=A1&"!"');
    const matches = findMatches(ctl, 'red', opts());
    expect(matches).toHaveLength(3);
    expect(replaceMatches(ctl, matches, 'red', 'blue', opts())).toBe(2);
    expect([value(ctl, 0, 0), value(ctl, 1, 0), value(ctl, 2, 0)]).toEqual(['blue car', 'blue bus', 'blue car!']);
    ctl.undo();
    expect(value(ctl, 0, 0)).toBe('red car');

    ctl.setInput(3, 0, '5');
    expect(replaceMatches(ctl, findMatches(ctl, '5', opts({ wholeCell: true })), '5', '7', opts({ wholeCell: true }))).toBe(1);
    expect(value(ctl, 3, 0)).toBe(7);
  });
});

describe('moving cells', () => {
  it('moves a block dragged by its outline, or copies it with Ctrl', () => {
    const ctl = make();
    ctl.setInput(0, 0, '1');
    ctl.setInput(1, 0, '=A1*2');
    ctl.select({ ranges: [{ r1: 0, c1: 0, r2: 1, c2: 0 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    moveCells(ctl, { r1: 0, c1: 0, r2: 1, c2: 0 }, 3, 2, true);
    expect(ctl.engine.getCell(ctl.activeSheetId, 4, 2)?.f).toBe('C4*2');
    expect(value(ctl, 0, 0)).toBe(1);
    expect(ctl.selection.ranges[0]).toEqual({ r1: 3, c1: 2, r2: 4, c2: 2 });

    moveCells(ctl, { r1: 3, c1: 2, r2: 4, c2: 2 }, 4, 2, false);
    expect([value(ctl, 3, 2), value(ctl, 4, 2), value(ctl, 5, 2)]).toEqual([null, 1, 2]);
    expect(ctl.engine.getCell(ctl.activeSheetId, 5, 2)?.f).toBe('C5*2');
    ctl.undo();
    expect([value(ctl, 3, 2), value(ctl, 4, 2), value(ctl, 5, 2)]).toEqual([1, 2, null]);
  });

  it('points formulas elsewhere at moved cells where they went', () => {
    const ctl = make();
    ctl.setInput(0, 0, '2');
    ctl.setInput(1, 0, '3');
    ctl.setInput(0, 3, '=SUM(A1:A2)');
    ctl.setInput(1, 3, '=A1+B9');
    moveCells(ctl, { r1: 0, c1: 0, r2: 1, c2: 0 }, 5, 1, false);
    expect(ctl.engine.getCell(ctl.activeSheetId, 0, 3)?.f).toBe('SUM(B6:B7)');
    expect(ctl.engine.getCell(ctl.activeSheetId, 1, 3)?.f).toBe('B6+B9');
    expect(value(ctl, 0, 3)).toBe(5);
    ctl.undo();
    expect(ctl.engine.getCell(ctl.activeSheetId, 0, 3)?.f).toBe('SUM(A1:A2)');
  });

  it('moves whole columns to before another, keeping them selected', () => {
    const ctl = make();
    ['a', 'b', 'c', 'd'].forEach((v, i) => ctl.setInput(0, i, v));
    ctl.moveDimsTo('col', 0, 2, 4);
    expect([0, 1, 2, 3].map((c) => value(ctl, 0, c))).toEqual(['c', 'd', 'a', 'b']);
    expect(ctl.selection.ranges[0]).toEqual(wholeColumns(2, 3));
  });

  it('pastes values only', () => {
    const ctl = make();
    ctl.setInput(0, 0, '4');
    ctl.setInput(0, 1, '=A1+1');
    ctl.select(cellSelection(0, 1));
    ctl.toggle('bold');
    const { text, html } = copySelection(ctl);
    ctl.select(cellSelection(2, 2));
    pasteInto(ctl, text, html, true);
    expect(ctl.engine.getCell(ctl.activeSheetId, 2, 2)).toMatchObject({ v: 5 });
    expect(ctl.engine.getCell(ctl.activeSheetId, 2, 2)?.f).toBeUndefined();
    expect(ctl.engine.workbook.style(ctl.sheet, 2, 2)?.bold).toBeUndefined();
  });
});

describe('fit to data', () => {
  const measure = (text: string) => text.length * 7;
  it('fits a column to its widest value, and a row to its tallest text', () => {
    const ctl = make();
    ctl.setInput(0, 0, 'short');
    ctl.setInput(5, 0, 'a much longer value');
    expect(fittedWidth(ctl, 0, measure)).toBe(19 * 7 + 10);
    expect(fittedWidth(ctl, 3, measure)).toBeNull();
    ctl.setInput(1, 1, 'one\ntwo\nthree');
    expect(fittedHeight(ctl, 1, measure)).toBe(Math.ceil(3 * (40 / 3) * 1.25 + 4));
    expect(fittedHeight(ctl, 0, measure)).toBeNull();
    fitToData(ctl, 'col', [0], measure);
    expect(ctl.sheet.cols.sizeOf(0)).toBe(143);
  });
});

describe('shortcuts', () => {
  it('fills, inserts the date and opens find', () => {
    const ctl = make();
    ctl.setInput(0, 0, 'x');
    ctl.select({ ranges: [{ r1: 0, c1: 0, r2: 2, c2: 0 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    expect(handleGridKey(ctl, key('d'), 10)).toBe(true);
    expect(value(ctl, 2, 0)).toBe('x');

    ctl.select(cellSelection(4, 4));
    handleGridKey(ctl, key(';'), 10);
    expect(typeof value(ctl, 4, 4)).toBe('number');
    expect(ctl.displayText(4, 4).text).toMatch(/^\d+\/\d+\/\d{4}$/);

    handleGridKey(ctl, key('h'), 10);
    expect(ctl.find).toBe('replace');
    ctl.setReadOnly(true);
    ctl.openFind('replace');
    expect(ctl.find).toBe('find');
  });
});
