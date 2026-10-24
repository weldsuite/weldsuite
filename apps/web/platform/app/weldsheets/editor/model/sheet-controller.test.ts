import { describe, expect, it, vi } from 'vitest';
import { EN_LOCALE, NL_LOCALE } from '@weldsuite/sheets-engine';
import { copySelection, parseHtmlTable, parseTsv, pasteInto } from './clipboard';
import { acceptsReference, functionPrefixAt, referenceText, refsInEdit, suggestFunctions } from './formula-edit';
import { handleEditKey, handleGridKey, type KeyInput } from './keyboard';
import { cellSelection, wholeColumns, wholeRows } from './selection';
import { adjustDecimals, SheetController } from './sheet-controller';

function make(locale: 'en' | 'nl' = 'en') {
  const onOp = vi.fn();
  const ctl = new SheetController(null, {
    locale: locale === 'nl' ? NL_LOCALE : EN_LOCALE,
    formulaLocale: { decimal: locale === 'nl' ? ',' : '.' },
    onOp,
  });
  return { ctl, onOp };
}

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

const value = (ctl: SheetController, row: number, col: number) => ctl.engine.getValue(ctl.activeSheetId, row, col);

describe('SheetController input', () => {
  it('parses typed values, formulas and implied formats', () => {
    const { ctl, onOp } = make();
    ctl.setInput(0, 0, '12');
    ctl.setInput(1, 0, '30%');
    ctl.setInput(2, 0, '=A1*A2');
    expect(value(ctl, 0, 0)).toBe(12);
    expect(value(ctl, 1, 0)).toBe(0.3);
    expect(ctl.activeStyle()).toEqual({});
    expect(ctl.engine.workbook.style(ctl.sheet, 1, 0)?.numFmt).toBe('0%');
    expect(value(ctl, 2, 0)).toBeCloseTo(3.6);
    expect(ctl.displayText(1, 0).text).toBe('30%');
    expect(onOp).toHaveBeenCalledTimes(3);
  });

  it('shows the input text back in the editing locale', () => {
    const { ctl } = make('nl');
    ctl.setInput(0, 0, '1,5');
    ctl.setInput(0, 1, '=ROUND(A1*2,5;1)');
    expect(value(ctl, 0, 0)).toBe(1.5);
    expect(ctl.engine.getCell(ctl.activeSheetId, 0, 1)?.f).toBe('ROUND(A1*2.5,1)');
    expect(ctl.inputText(0, 1)).toBe('=ROUND(A1*2,5;1)');
    expect(ctl.inputText(0, 0)).toBe('1,5');
    ctl.setInput(1, 0, "'=not a formula");
    expect(value(ctl, 1, 0)).toBe('=not a formula');
    expect(ctl.inputText(1, 0)).toBe("'=not a formula");
  });

  it('edits through beginEdit / commitEdit and undoes', () => {
    const { ctl } = make();
    ctl.beginEdit({ text: 'hello' });
    expect(ctl.editing?.replace).toBe(true);
    ctl.commitEdit();
    expect(value(ctl, 0, 0)).toBe('hello');
    ctl.undo();
    expect(value(ctl, 0, 0)).toBeNull();
    ctl.redo();
    expect(value(ctl, 0, 0)).toBe('hello');
  });

  it('ignores edits, undo and editing in read-only mode', () => {
    const { ctl, onOp } = make();
    ctl.setInput(0, 0, '1');
    ctl.setReadOnly(true);
    ctl.setInput(0, 0, '2');
    ctl.clearContents();
    ctl.undo();
    ctl.beginEdit({ text: 'x' });
    expect(ctl.editing).toBeNull();
    expect(value(ctl, 0, 0)).toBe(1);
    expect(onOp).toHaveBeenCalledTimes(1);
    ctl.setReadOnly(false);
    ctl.setInput(0, 0, '3');
    expect(value(ctl, 0, 0)).toBe(3);
  });

  it('does not write when an edit is committed unchanged', () => {
    const { ctl, onOp } = make();
    ctl.beginEdit();
    ctl.commitEdit();
    expect(onOp).not.toHaveBeenCalled();
  });

  it('fills a selection with ctrl+enter, moving relative references', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, '1');
    ctl.setInput(1, 0, '2');
    ctl.select({ ranges: [{ r1: 0, c1: 1, r2: 1, c2: 1 }], active: { row: 0, col: 1 }, anchor: { row: 0, col: 1 } });
    ctl.fillSelection('=A1*10');
    expect(value(ctl, 0, 1)).toBe(10);
    expect(value(ctl, 1, 1)).toBe(20);
  });
});

describe('SheetController formatting and structure', () => {
  it('notes when someone moves, not when they only stretch a selection', () => {
    const { ctl } = make();
    const peer = (row: number, ranges = [{ r1: row, c1: 0, r2: row, c2: 0 }], editing = false) => ({
      clientId: 'c1',
      userId: 'u1',
      name: 'Anna',
      color: '#dc2626',
      canEdit: true,
      presence: { sheetId: ctl.activeSheetId, active: { row, col: 0 }, ranges, editing },
    });
    ctl.setPeers([peer(2)], 1000);
    expect(ctl.peerMovedAt('c1')).toBe(1000);
    ctl.setPeers([peer(2, [{ r1: 2, c1: 0, r2: 5, c2: 3 }])], 2000);
    expect(ctl.peerMovedAt('c1')).toBe(1000);
    ctl.setPeers([peer(2, undefined, true)], 3000);
    expect(ctl.peerMovedAt('c1')).toBe(3000);
    ctl.setPeers([peer(4)], 4000);
    expect(ctl.peerMovedAt('c1')).toBe(4000);
    ctl.setPeers([], 5000);
    expect(ctl.peerMovedAt('c1')).toBeUndefined();
  });

  it('drops an open edit when its sheet is deleted', () => {
    const { ctl } = make();
    const first = ctl.activeSheetId;
    ctl.addSheet();
    const second = ctl.engine.workbook.sheets[1]!.id;
    ctl.setActiveSheet(second);
    ctl.select(cellSelection(2, 1));
    ctl.beginEdit({ text: 'abc' });
    ctl.deleteSheet(second);
    expect(ctl.activeSheetId).toBe(first);
    expect(ctl.editing).toBeNull();
    ctl.commitEdit();
    expect(value(ctl, 2, 1)).toBeNull();
  });

  it('clears formatting kept on whole columns and rows', () => {
    const { ctl } = make();
    ctl.select({ ranges: [wholeColumns(0, 0)], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    ctl.toggle('bold');
    expect(ctl.engine.workbook.style(ctl.sheet, 5, 0)?.bold).toBe(true);
    ctl.clearFormatting();
    expect(ctl.engine.workbook.style(ctl.sheet, 5, 0)?.bold).toBeUndefined();
    expect(ctl.sheet.cols.styles.size).toBe(0);

    ctl.select({ ranges: [wholeRows(2, 3)], active: { row: 2, col: 0 }, anchor: { row: 2, col: 0 } });
    ctl.toggle('italic');
    expect(ctl.sheet.rows.styles.size).toBe(2);
    ctl.clearFormatting();
    expect(ctl.sheet.rows.styles.size).toBe(0);
    ctl.undo();
    expect(ctl.sheet.rows.styles.size).toBe(2);
  });

  it('toggles bold from the active cell and changes decimals', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, '1.5');
    ctl.toggle('bold');
    expect(ctl.activeStyle().bold).toBe(true);
    ctl.toggle('bold');
    expect(ctl.activeStyle().bold).toBeUndefined();
    ctl.changeDecimals(1);
    expect(ctl.activeStyle().numFmt).toBe('0.00');
    ctl.changeDecimals(-1);
    ctl.changeDecimals(-1);
    expect(ctl.activeStyle().numFmt).toBe('0');
  });

  it('adjusts decimals in every section and skips quoted text', () => {
    expect(adjustDecimals('#,##0.00', 1)).toBe('#,##0.000');
    expect(adjustDecimals('0', 1)).toBe('0.0');
    expect(adjustDecimals('0.0', -1)).toBe('0');
    expect(adjustDecimals('"€ "#,##0.00;"€ -"#,##0.00', -1)).toBe('"€ "#,##0.0;"€ -"#,##0.0');
    expect(adjustDecimals('[Red]0.00%', 1)).toBe('[Red]0.000%');
  });

  it('sets outer borders on the edges only', () => {
    const { ctl } = make();
    ctl.select({ ranges: [{ r1: 0, c1: 0, r2: 2, c2: 2 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    ctl.setBorders('outer');
    const style = (r: number, c: number) => ctl.engine.workbook.style(ctl.sheet, r, c) ?? {};
    expect(style(0, 0).borderTop).toBeDefined();
    expect(style(0, 0).borderLeft).toBeDefined();
    expect(style(1, 1)).toEqual({});
    expect(style(2, 2).borderBottom).toBeDefined();
    ctl.setBorders('none');
    expect(style(0, 0).borderTop).toBeUndefined();
  });

  it('merges keeping the top-left value, and unmerges', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, 'keep');
    ctl.setInput(1, 1, 'gone');
    ctl.select({ ranges: [{ r1: 0, c1: 0, r2: 1, c2: 1 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    ctl.toggleMerge();
    expect(ctl.sheet.merges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
    expect(value(ctl, 1, 1)).toBeNull();
    ctl.toggleMerge();
    expect(ctl.sheet.merges).toEqual([]);
  });

  it('inserts and deletes rows around the selection', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, '1');
    ctl.setInput(1, 0, '=A1+1');
    ctl.select(cellSelection(1, 0));
    ctl.insertDims('row', 'before');
    expect(value(ctl, 2, 0)).toBe(2);
    expect(ctl.engine.getCell(ctl.activeSheetId, 2, 0)?.f).toBe('A1+1');
    ctl.select(cellSelection(0, 0));
    ctl.deleteDims('row');
    expect(ctl.engine.getCell(ctl.activeSheetId, 1, 0)?.f).toBe('#REF!+1');
    ctl.undo();
    expect(ctl.engine.getCell(ctl.activeSheetId, 2, 0)?.f).toBe('A1+1');
  });

  it('writes =SUM(range) below a selected column', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, '2');
    ctl.setInput(1, 0, '3');
    ctl.select({ ranges: [{ r1: 0, c1: 0, r2: 1, c2: 0 }], active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 } });
    ctl.insertFunction('SUM');
    expect(value(ctl, 2, 0)).toBe(5);
    expect(ctl.selection.active).toEqual({ row: 2, col: 0 });
  });

  it('adds, renames, duplicates and deletes sheets', () => {
    const { ctl } = make();
    const first = ctl.activeSheetId;
    ctl.addSheet();
    expect(ctl.engine.workbook.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2']);
    expect(ctl.renameSheet(ctl.activeSheetId, 'Sheet1')).toBe(false);
    expect(ctl.renameSheet(ctl.activeSheetId, 'Data')).toBe(true);
    ctl.setInput(0, 0, '7');
    ctl.setActiveSheet(first);
    ctl.setInput(0, 0, '=Data!A1*2');
    expect(value(ctl, 0, 0)).toBe(14);
    ctl.duplicateSheet(first);
    expect(ctl.sheet.name).toBe('Sheet1 copy');
    ctl.deleteSheet(ctl.activeSheetId);
    expect(ctl.engine.workbook.sheets).toHaveLength(2);
  });
});

describe('navigation and keys', () => {
  it('jumps to the edge of data with ctrl+arrow', () => {
    const { ctl } = make();
    for (const r of [0, 1, 2, 6]) ctl.setInput(r, 0, String(r));
    ctl.select(cellSelection(0, 0));
    handleGridKey(ctl, key('ArrowDown', { ctrlKey: true }), 20);
    expect(ctl.selection.active.row).toBe(2);
    handleGridKey(ctl, key('ArrowDown', { ctrlKey: true }), 20);
    expect(ctl.selection.active.row).toBe(6);
    handleGridKey(ctl, key('ArrowDown', { ctrlKey: true }), 20);
    expect(ctl.selection.active.row).toBe(ctl.sheet.rowCount - 1);
  });

  it('extends with shift+arrow and walks a selection with Tab', () => {
    const { ctl } = make();
    handleGridKey(ctl, key('ArrowRight', { shiftKey: true }), 20);
    handleGridKey(ctl, key('ArrowDown', { shiftKey: true }), 20);
    expect(ctl.selection.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
    handleGridKey(ctl, key('Tab'), 20);
    handleGridKey(ctl, key('Tab'), 20);
    expect(ctl.selection.active).toEqual({ row: 1, col: 0 });
  });

  it('commits on Enter and cancels on Escape', () => {
    const { ctl } = make();
    ctl.beginEdit({ text: '5' });
    expect(handleEditKey(ctl, key('Enter'))).toBe(true);
    expect(value(ctl, 0, 0)).toBe(5);
    expect(ctl.selection.active).toEqual({ row: 1, col: 0 });
    ctl.beginEdit({ text: 'x' });
    handleEditKey(ctl, key('Escape'));
    expect(value(ctl, 1, 0)).toBeNull();
  });

  it('commits typed-over cells on arrows but keeps arrows inside formulas', () => {
    const { ctl } = make();
    ctl.beginEdit({ text: '1' });
    expect(handleEditKey(ctl, key('ArrowRight'))).toBe(true);
    expect(value(ctl, 0, 0)).toBe(1);
    ctl.beginEdit({ text: '=A1' });
    expect(handleEditKey(ctl, key('ArrowRight'))).toBe(false);
  });

  it('undoes with ctrl+z and clears with Delete', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, 'x');
    handleGridKey(ctl, key('Delete'), 20);
    expect(value(ctl, 0, 0)).toBeNull();
    handleGridKey(ctl, key('z', { ctrlKey: true }), 20);
    expect(value(ctl, 0, 0)).toBe('x');
  });
});

describe('clipboard', () => {
  it('parses TSV with quoted fields', () => {
    expect(parseTsv('a\tb\n"c\td"\t"e ""q"""\n')).toEqual([
      ['a', 'b'],
      ['c\td', 'e "q"'],
    ]);
    expect(parseTsv('')).toEqual([]);
  });

  it('parses an HTML table', () => {
    expect(parseHtmlTable('<table><tr><td>1</td><td colspan="2">x</td></tr><tr><th>a</th></tr></table>')).toEqual([
      ['1', 'x', ''],
      ['a'],
    ]);
  });

  it('copies and pastes inside WeldSheets with relative formulas and styles', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, '1');
    ctl.setInput(0, 1, '=A1*2');
    ctl.select(cellSelection(0, 1));
    ctl.toggle('bold');
    const payload = copySelection(ctl);
    expect(payload.text).toBe('2');
    ctl.setInput(4, 0, '10');
    ctl.select(cellSelection(4, 1));
    pasteInto(ctl, payload.text, payload.html);
    expect(ctl.engine.getCell(ctl.activeSheetId, 4, 1)?.f).toBe('A5*2');
    expect(value(ctl, 4, 1)).toBe(20);
    expect(ctl.activeStyle().bold).toBe(true);
  });

  it('pastes external text, parsing numbers and dates', () => {
    const { ctl } = make();
    pasteInto(ctl, 'Name\tAmount\nAcme\t1,250.50\n', null);
    expect(value(ctl, 0, 1)).toBe('Amount');
    expect(value(ctl, 1, 1)).toBe(1250.5);
  });

  it('pastes a cut from another spreadsheet as a copy instead of failing', () => {
    const source = make().ctl;
    source.setInput(0, 0, 'from A');
    const payload = copySelection(source, true);
    const target = make().ctl;
    target.select(cellSelection(2, 2));
    pasteInto(target, payload.text, payload.html);
    expect(value(target, 2, 2)).toBe('from A');
    expect(value(source, 0, 0)).toBe('from A');
  });

  it('pastes a cut as a copy when its source sheet was deleted', () => {
    const { ctl } = make();
    ctl.addSheet();
    ctl.setInput(0, 0, 'x');
    const payload = copySelection(ctl, true);
    const doomed = ctl.activeSheetId;
    ctl.setActiveSheet(ctl.engine.workbook.sheets[0]!.id);
    ctl.deleteSheet(doomed);
    pasteInto(ctl, payload.text, null);
    expect(value(ctl, 0, 0)).toBe('x');
  });

  it('moves content on cut and paste', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, 'moved');
    const payload = copySelection(ctl, true);
    ctl.select(cellSelection(3, 3));
    pasteInto(ctl, payload.text, null);
    expect(value(ctl, 0, 0)).toBeNull();
    expect(value(ctl, 3, 3)).toBe('moved');
  });
});

describe('formula editing helpers', () => {
  it('knows where a clicked cell may be inserted', () => {
    expect(acceptsReference('=SUM(', 5)).toBe(true);
    expect(acceptsReference('=A1+', 4)).toBe(true);
    expect(acceptsReference('=A1', 3)).toBe(false);
    expect(acceptsReference('hello', 5)).toBe(false);
  });

  it('formats references, qualifying other sheets', () => {
    expect(referenceText({ r1: 0, c1: 0, r2: 2, c2: 1 }, 'Sheet1', 'Sheet1')).toBe('A1:B3');
    expect(referenceText({ r1: 4, c1: 2, r2: 4, c2: 2 }, 'Q1 data', 'Sheet1')).toBe("'Q1 data'!C5");
  });

  it('finds references to highlight, with a stable colour per reference', () => {
    const refs = refsInEdit('=A1+B2:C3+A1+Other!D4', 'Sheet1', { decimal: '.' });
    expect(refs.map((r) => r.colorIndex)).toEqual([0, 1, 0]);
  });

  it('suggests functions for the name being typed', () => {
    expect(functionPrefixAt('=SU', 3)).toEqual({ start: 1, prefix: 'SU' });
    expect(functionPrefixAt('=A1+xl', 6)).toEqual({ start: 4, prefix: 'xl' });
    expect(functionPrefixAt('=SUM(A1)', 8)).toBeNull();
    expect(suggestFunctions('xloo')).toEqual(['XLOOKUP']);
  });
});
