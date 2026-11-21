import { describe, expect, it } from 'vitest';
import { EN_LOCALE } from '@weldsuite/sheets-engine';
import { cellHint, selectedHintCell, type CellHintStrings } from './cell-hint';
import { saveValidation } from './rules';
import { cellSelection, rangeFrom } from './selection';
import { SheetController } from './sheet-controller';

const strings: CellHintStrings = {
  invalid: 'invalid',
  invalidList: 'pick from list',
  parseError: 'bad syntax',
  errors: {
    '#NULL!': 'null',
    '#DIV/0!': 'div0',
    '#VALUE!': 'value',
    '#REF!': 'ref',
    '#NAME?': 'name',
    '#NUM!': 'num',
    '#N/A': 'na',
    '#SPILL!': 'spill',
    '#CALC!': 'calc',
  },
};

describe('cellHint', () => {
  it('explains an error value', () => {
    const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
    ctl.setInput(0, 0, '=1/0');
    expect(cellHint(ctl, 0, 0, strings)).toBe('div0');
    ctl.setInput(1, 0, '5');
    expect(cellHint(ctl, 1, 0, strings)).toBeNull();
    expect(cellHint(ctl, 5, 5, strings)).toBeNull();
  });

  it('calls a formula that does not parse a syntax mistake, not a missing name', () => {
    const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
    ctl.setInput(0, 0, '=SUM(A1:');
    expect(cellHint(ctl, 0, 0, strings)).toBe('bad syntax');
    ctl.setInput(1, 0, '=NOSUCHFN(1)');
    expect(cellHint(ctl, 1, 0, strings)).toContain('name');
  });

  it('explains a value a list rule refuses, with the rule help text first', () => {
    const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
    saveValidation(ctl, { id: 'v1', ranges: [{ r1: 0, c1: 0, r2: 3, c2: 0 }], criteria: { type: 'list', values: ['a', 'b'] }, strict: false, dropdown: true });
    ctl.setInput(0, 0, 'abc');
    ctl.setInput(1, 0, 'a');
    expect(cellHint(ctl, 0, 0, strings)).toBe('pick from list');
    expect(cellHint(ctl, 1, 0, strings)).toBeNull();
    saveValidation(ctl, { id: 'v1', ranges: [{ r1: 0, c1: 0, r2: 3, c2: 0 }], criteria: { type: 'list', values: ['a', 'b'] }, strict: false, help: 'Use a or b' });
    expect(cellHint(ctl, 0, 0, strings)).toBe('Use a or b');
  });
});

describe('selectedHintCell', () => {
  it('is the active cell only while exactly one cell is selected', () => {
    const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
    ctl.select(cellSelection(1, 1));
    expect(selectedHintCell(ctl)).toEqual({ row: 1, col: 1 });
    ctl.select({ ranges: [rangeFrom({ row: 1, col: 1 }, { row: 2, col: 2 })], active: { row: 1, col: 1 }, anchor: { row: 1, col: 1 } });
    expect(selectedHintCell(ctl)).toBeNull();
  });

  it('counts a merged cell as one', () => {
    const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
    ctl.apply({ type: 'merge', sheetId: ctl.activeSheetId, ranges: [{ r1: 0, c1: 0, r2: 0, c2: 2 }] });
    ctl.select({ ranges: [{ r1: 0, c1: 0, r2: 0, c2: 2 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    expect(selectedHintCell(ctl)).toEqual({ row: 0, col: 0 });
  });
});
