import { describe, expect, it } from 'vitest';
import { EN_LOCALE, NL_LOCALE, serialFromYMD, ymdFromSerial } from '@weldsuite/sheets-engine';
import { fillTarget } from './autofill';
import { cellSelection } from './selection';
import { SheetController } from './sheet-controller';

function make(locale: 'en' | 'nl' = 'en') {
  return new SheetController(null, {
    locale: locale === 'nl' ? NL_LOCALE : EN_LOCALE,
    formulaLocale: { decimal: locale === 'nl' ? ',' : '.' },
  });
}

const value = (ctl: SheetController, row: number, col: number) => ctl.engine.getValue(ctl.activeSheetId, row, col);
const column = (ctl: SheetController, col: number, from: number, to: number) => {
  const out = [];
  for (let r = from; r <= to; r++) out.push(value(ctl, r, col));
  return out;
};

/** Selects rows r1..r2 of column `col` (or a block) and drags the fill handle to `target`. */
function fillFrom(ctl: SheetController, r1: number, c1: number, r2: number, c2: number, target: { r1: number; c1: number; r2: number; c2: number }, toggle = false) {
  ctl.select({ ranges: [{ r1, c1, r2, c2 }], active: { row: r1, col: c1 }, anchor: { row: r1, col: c1 } });
  ctl.fill(target, toggle);
}

describe('fillTarget', () => {
  const src = { r1: 2, c1: 2, r2: 4, c2: 3 };
  it('grows along the axis the pointer moved furthest on', () => {
    expect(fillTarget(src, 9, 4)).toEqual({ ...src, r2: 9 });
    expect(fillTarget(src, 0, 3)).toEqual({ ...src, r1: 0 });
    expect(fillTarget(src, 5, 8)).toEqual({ ...src, c2: 8 });
    expect(fillTarget(src, 3, 0)).toEqual({ ...src, c1: 0 });
  });
  it('shrinks when pulled back inside', () => {
    expect(fillTarget(src, 4, 3)).toEqual(src);
    expect(fillTarget(src, 2, 3)).toEqual({ ...src, r2: 2 });
    expect(fillTarget(src, 4, 2)).toEqual({ ...src, c2: 2 });
  });
});

describe('autofill', () => {
  it('continues a number series, and its trend', () => {
    const ctl = make();
    ctl.setInput(0, 0, '1');
    ctl.setInput(1, 0, '2');
    ctl.setInput(2, 0, '3');
    fillFrom(ctl, 0, 0, 2, 0, { r1: 0, c1: 0, r2: 5, c2: 0 });
    expect(column(ctl, 0, 0, 5)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ctl.selection.ranges[0]).toEqual({ r1: 0, c1: 0, r2: 5, c2: 0 });

    ctl.setInput(0, 1, '0.1');
    ctl.setInput(1, 1, '0.2');
    fillFrom(ctl, 0, 1, 1, 1, { r1: 0, c1: 1, r2: 3, c2: 1 });
    expect(column(ctl, 1, 2, 3)).toEqual([0.3, 0.4]);

    // Not evenly spaced: Excel's least-squares trend.
    ctl.setInput(0, 2, '1');
    ctl.setInput(1, 2, '2');
    ctl.setInput(2, 2, '4');
    fillFrom(ctl, 0, 2, 2, 2, { r1: 0, c1: 2, r2: 3, c2: 2 });
    expect(value(ctl, 3, 2)).toBeCloseTo(5.333333333333, 9);
  });

  it('copies a single number, and counts with Ctrl; Ctrl copies a series', () => {
    const ctl = make();
    ctl.setInput(0, 0, '7');
    fillFrom(ctl, 0, 0, 0, 0, { r1: 0, c1: 0, r2: 2, c2: 0 });
    expect(column(ctl, 0, 0, 2)).toEqual([7, 7, 7]);
    fillFrom(ctl, 0, 0, 0, 0, { r1: 0, c1: 0, r2: 2, c2: 0 }, true);
    expect(column(ctl, 0, 0, 2)).toEqual([7, 8, 9]);

    ctl.setInput(0, 1, '1');
    ctl.setInput(1, 1, '2');
    fillFrom(ctl, 0, 1, 1, 1, { r1: 0, c1: 1, r2: 3, c2: 1 }, true);
    expect(column(ctl, 1, 0, 3)).toEqual([1, 2, 1, 2]);
  });

  it('fills up and left backwards', () => {
    const ctl = make();
    ctl.setInput(5, 0, '1');
    ctl.setInput(6, 0, '2');
    fillFrom(ctl, 5, 0, 6, 0, { r1: 3, c1: 0, r2: 6, c2: 0 });
    expect(column(ctl, 0, 3, 6)).toEqual([-1, 0, 1, 2]);

    ctl.setInput(0, 5, 'Mon');
    fillFrom(ctl, 0, 5, 0, 5, { r1: 0, c1: 3, r2: 0, c2: 5 });
    expect([value(ctl, 0, 3), value(ctl, 0, 4)]).toEqual(['Sat', 'Sun']);
  });

  it('counts numbered text, keeping zeros and the rest of the text', () => {
    const ctl = make();
    ctl.setInput(0, 0, 'Item 1');
    fillFrom(ctl, 0, 0, 0, 0, { r1: 0, c1: 0, r2: 2, c2: 0 });
    expect(column(ctl, 0, 0, 2)).toEqual(['Item 1', 'Item 2', 'Item 3']);

    ctl.setInput(0, 1, 'Q01 total');
    ctl.setInput(1, 1, 'Q03 total');
    fillFrom(ctl, 0, 1, 1, 1, { r1: 0, c1: 1, r2: 3, c2: 1 });
    expect(column(ctl, 1, 2, 3)).toEqual(['Q05 total', 'Q07 total']);

    // Plain text repeats.
    ctl.setInput(0, 2, 'a');
    ctl.setInput(1, 2, 'b');
    fillFrom(ctl, 0, 2, 1, 2, { r1: 0, c1: 2, r2: 4, c2: 2 });
    expect(column(ctl, 2, 0, 4)).toEqual(['a', 'b', 'a', 'b', 'a']);
  });

  it('goes round weekday and month names in their case and step', () => {
    const ctl = make();
    ctl.setInput(0, 0, 'Friday');
    fillFrom(ctl, 0, 0, 0, 0, { r1: 0, c1: 0, r2: 3, c2: 0 });
    expect(column(ctl, 0, 1, 3)).toEqual(['Saturday', 'Sunday', 'Monday']);

    ctl.setInput(0, 1, 'JAN');
    ctl.setInput(1, 1, 'MAR');
    fillFrom(ctl, 0, 1, 1, 1, { r1: 0, c1: 1, r2: 3, c2: 1 });
    expect(column(ctl, 1, 2, 3)).toEqual(['MAY', 'JUL']);

    const nl = make('nl');
    nl.setInput(0, 0, 'maandag');
    fillFrom(nl, 0, 0, 0, 0, { r1: 0, c1: 0, r2: 1, c2: 0 });
    expect(value(nl, 1, 0)).toBe('dinsdag');
  });

  it('steps dates by a day, and by months when they share a day', () => {
    const ctl = make();
    ctl.setInput(0, 0, '1/30/2026');
    fillFrom(ctl, 0, 0, 0, 0, { r1: 0, c1: 0, r2: 2, c2: 0 });
    expect(value(ctl, 2, 0)).toBe(serialFromYMD(2026, 2, 1));
    expect(ctl.displayText(2, 0).text).toBe('2/1/2026');

    ctl.setInput(0, 1, '1/31/2026');
    ctl.setInput(1, 1, '2/28/2026');
    // Not the same day: by the days between them.
    fillFrom(ctl, 0, 1, 1, 1, { r1: 0, c1: 1, r2: 2, c2: 1 });
    expect(value(ctl, 2, 1)).toBe(serialFromYMD(2026, 3, 28));

    ctl.setInput(0, 2, '1/15/2026');
    ctl.setInput(1, 2, '4/15/2026');
    fillFrom(ctl, 0, 2, 1, 2, { r1: 0, c1: 2, r2: 3, c2: 2 });
    expect(ymdFromSerial(value(ctl, 3, 2) as number)).toEqual({ year: 2026, month: 10, day: 15 });
  });

  it('moves formulas and repeats styles', () => {
    const ctl = make();
    ctl.setInput(0, 0, '2');
    ctl.setInput(1, 0, '3');
    ctl.setInput(2, 0, '4');
    ctl.setInput(0, 1, '=A1*10');
    ctl.select(cellSelection(0, 1));
    ctl.toggle('bold');
    ctl.fill({ r1: 0, c1: 1, r2: 2, c2: 1 });
    expect(column(ctl, 1, 0, 2)).toEqual([20, 30, 40]);
    expect(ctl.engine.getCell(ctl.activeSheetId, 2, 1)?.f).toBe('A3*10');
    expect(ctl.engine.workbook.style(ctl.sheet, 2, 1)?.bold).toBe(true);
  });

  it('clears what the handle is pulled back over, and undoes as one step', () => {
    const ctl = make();
    for (let r = 0; r < 4; r++) ctl.setInput(r, 0, String(r + 1));
    fillFrom(ctl, 0, 0, 3, 0, { r1: 0, c1: 0, r2: 1, c2: 0 });
    expect(column(ctl, 0, 0, 3)).toEqual([1, 2, null, null]);
    ctl.undo();
    expect(column(ctl, 0, 0, 3)).toEqual([1, 2, 3, 4]);

    fillFrom(ctl, 0, 0, 3, 0, { r1: 0, c1: 0, r2: 6, c2: 0 });
    expect(column(ctl, 0, 4, 6)).toEqual([5, 6, 7]);
    ctl.undo();
    expect(column(ctl, 0, 4, 6)).toEqual([null, null, null]);
    expect(ctl.selection.ranges[0]).toEqual({ r1: 0, c1: 0, r2: 3, c2: 0 });
  });

  it('fills down as far as the column next to it on a double-click', () => {
    const ctl = make();
    for (let r = 0; r < 6; r++) ctl.setInput(r, 0, `x${r}`);
    ctl.setInput(0, 1, '1');
    ctl.setInput(1, 1, '2');
    ctl.select({ ranges: [{ r1: 0, c1: 1, r2: 1, c2: 1 }], active: { row: 0, col: 1 }, anchor: { row: 0, col: 1 } });
    ctl.fillToAdjacent();
    expect(column(ctl, 1, 0, 6)).toEqual([1, 2, 3, 4, 5, 6, null]);
  });

  it('copies down and right with Ctrl+D and Ctrl+R', () => {
    const ctl = make();
    ctl.setInput(0, 0, '5');
    ctl.setInput(0, 1, '=A1+1');
    ctl.select({ ranges: [{ r1: 0, c1: 0, r2: 3, c2: 1 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    ctl.fillDown();
    expect(column(ctl, 0, 0, 3)).toEqual([5, 5, 5, 5]);
    expect(ctl.engine.getCell(ctl.activeSheetId, 3, 1)?.f).toBe('A4+1');

    // One cell: from the cell to its left.
    ctl.select(cellSelection(0, 2));
    ctl.fillRight();
    expect(ctl.engine.getCell(ctl.activeSheetId, 0, 2)?.f).toBe('B1+1');
  });

  it('shows what the last cell will get while dragging', () => {
    const ctl = make();
    ctl.setInput(0, 0, 'Week 1');
    ctl.select(cellSelection(0, 0));
    expect(ctl.fillHint({ r1: 0, c1: 0, r2: 9, c2: 0 })).toBe('Week 10');
    expect(ctl.fillHint({ r1: 0, c1: 0, r2: 0, c2: 0 })).toBeNull();
  });
});
