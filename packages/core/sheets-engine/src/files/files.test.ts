import { describe, expect, it } from 'vitest';
import { parseXml } from '@weldsuite/zip-xml';
import { Engine } from '../calc/engine';
import { NL_LOCALE } from '../format/number-format';
import { styleKey } from '../model/styles';
import { detectDelimiter, parseCsv, readCsv, writeCsv } from './csv';
import { readSpreadsheet, spreadsheetFormat } from './index';
import { ImportError } from './types';
import { fromExcelFormula, toExcelFormula } from './xlsx/formulas';
import { decodeEscapes, escCellText } from './xlsx/text';

const text = (s: string) => new TextEncoder().encode(s);

describe('SpreadsheetML text', () => {
  it('escapes cell text SpreadsheetML style, and reads it back', () => {
    const original = 'a\u0001b _x0041_ <&>';
    const written = escCellText(original);
    expect(written).toBe('a_x0001_b _x005F_x0041_ &lt;&amp;&gt;');
    expect(decodeEscapes(parseXml(`<t>${written}</t>`).text)).toBe('a\u0001b _x0041_ <&>');
  });
});

describe('formulas in files', () => {
  it('drops and adds the prefixes of newer functions', () => {
    expect(fromExcelFormula('_xlfn.XLOOKUP(A1,B:B,C:C)')).toBe('XLOOKUP(A1,B:B,C:C)');
    expect(fromExcelFormula('=_xlfn._xlws.FILTER(A1:A9,B1:B9>0)')).toBe('FILTER(A1:A9,B1:B9>0)');
    expect(fromExcelFormula('_xlfn.SINGLE(A1:A3)+1')).toBe('(A1:A3)+1');
    expect(toExcelFormula('XLOOKUP(A1,B:B,C:C)+SUM(FILTER(A:A,B:B>1))')).toBe('_xlfn.XLOOKUP(A1,B:B,C:C)+SUM(_xlfn._xlws.FILTER(A:A,B:B>1))');
    expect(toExcelFormula('IF(A1>1,"_xlfn.X",1)')).toBe('IF(A1>1,"_xlfn.X",1)');
  });

  it('gives null for formulas WeldSheets cannot read', () => {
    expect(fromExcelFormula('SUM(Table1[Amount])')).toBeNull();
    expect(fromExcelFormula('[1]Sheet1!A1')).toBeNull();
  });
});

describe('csv', () => {
  it('parses quotes, separators and line breaks inside quotes, and a BOM', () => {
    expect(parseCsv('a,"b,c","d ""e""",\r\n"multi\nline",2\n', ',')).toEqual([
      ['a', 'b,c', 'd "e"', ''],
      ['multi\nline', '2'],
    ]);
    const { workbook } = readCsv('\uFEFFName,Qty\nPear,3\n');
    expect(workbook.sheets[0]!.cells.map(([r, c, cell]) => [r, c, cell.v])).toEqual([
      [0, 0, 'Name'],
      [0, 1, 'Qty'],
      [1, 0, 'Pear'],
      [1, 1, 3],
    ]);
  });

  it('finds the separator', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('"x;y",b\n1,2\n')).toBe(',');
    expect(detectDelimiter('single\ncolumn\n')).toBe(',');
  });

  it('reads fields as typed input in the locale, formulas included', () => {
    const { workbook } = readCsv('Prijs;Datum;Deel\n1,5;15-01-2026;12%\n=1+2;tekst;\n', { locale: NL_LOCALE });
    const cells = new Map(workbook.sheets[0]!.cells.map(([r, c, cell]) => [`${r}:${c}`, cell]));
    expect(cells.get('1:0')).toEqual({ v: 1.5 });
    expect(cells.get('1:1')!.v).toBe(46037);
    expect(cells.get('1:2')).toEqual({ v: 0.12, s: styleKey({ numFmt: '0%' }) });
    expect(cells.get('2:0')).toEqual({ v: null, f: '1+2' });
    expect(cells.has('2:2')).toBe(false);
  });

  it('writes what cells show, quoting where needed, with ";" for a decimal comma', () => {
    const engine = Engine.fromSnapshot(readCsv('Item,Price\n"Tea, green",3.5\n=A2&"!",12%\n').workbook);
    expect(writeCsv(engine, 'sheet1')).toBe('Item,Price\r\n"Tea, green",3.5\r\n"Tea, green!",12%\r\n');
    expect(writeCsv(engine, 'sheet1', { locale: NL_LOCALE })).toBe('Item;Price\r\nTea, green;3,5\r\nTea, green!;12%\r\n');
  });

  it('refuses more cells than allowed', () => {
    expect(() => readCsv('a,b,c\n1,2,3\n', { maxCells: 4 })).toThrow(ImportError);
  });
});

describe('spreadsheet formats', () => {
  it('tells formats apart by content and name', async () => {
    expect(spreadsheetFormat('book.xlsx', new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('xlsx');
    expect(spreadsheetFormat('book.ods', new Uint8Array([0x50, 0x4b, 3, 4]))).toBeNull();
    expect(spreadsheetFormat('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBeNull();
    expect(spreadsheetFormat('data.tsv', text('a\tb'))).toBe('tsv');
    expect(spreadsheetFormat('data.csv', text('a,b'))).toBe('csv');
    expect(spreadsheetFormat('notes.pdf', text('%PDF'))).toBeNull();
    const tsv = await readSpreadsheet('Stock.tsv', text('a\tb,c\n'));
    expect(tsv.workbook.sheets[0]!.name).toBe('Stock');
    expect(tsv.workbook.sheets[0]!.cells.map(([, , c]) => c.v)).toEqual(['a', 'b,c']);
    await expect(readSpreadsheet('old.xls', new Uint8Array([0xd0, 0xcf]))).rejects.toMatchObject({ code: 'unsupported' });
  });
});
