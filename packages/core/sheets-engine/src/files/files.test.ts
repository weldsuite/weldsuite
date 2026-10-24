import { describe, expect, it } from 'vitest';
import { Engine } from '../calc/engine';
import { NL_LOCALE } from '../format/number-format';
import { styleKey } from '../model/styles';
import { detectDelimiter, parseCsv, readCsv, writeCsv } from './csv';
import { readSpreadsheet, spreadsheetFormat } from './index';
import { ImportError } from './types';
import { escCellText, decodeEscapes, parseXml, scanXml } from './xml';
import { fromExcelFormula, toExcelFormula } from './xlsx/formulas';
import { crc32, openZip, writeZip, ZipError } from './zip';

const text = (s: string) => new TextEncoder().encode(s);

describe('zip', () => {
  it('writes entries and reads them back, by name in any case', async () => {
    const zip = await writeZip([
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'docs/ünïcode.txt', data: 'héllo '.repeat(1000) },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ]);
    const reader = openZip(zip);
    expect(reader.names()).toEqual(['xl/workbook.xml', 'docs/ünïcode.txt', 'empty.bin']);
    expect(await reader.readText('XL/Workbook.xml')).toBe('<workbook/>');
    expect(await reader.readText('/docs/ünïcode.txt')).toBe('héllo '.repeat(1000));
    expect((await reader.read('empty.bin'))?.byteLength).toBe(0);
    expect(await reader.read('missing.xml')).toBeNull();
  });

  it('reads stored (uncompressed) entries', async () => {
    expect(await openZip(storedZip('a.txt', 'plain')).readText('a.txt')).toBe('plain');
  });

  it('refuses what is not a zip, damaged entries and entries that expand too far', async () => {
    expect(() => openZip(text('just some text'))).toThrow(ZipError);
    const zip = storedZip('a.txt', 'plain');
    zip[zip.indexOf(0x70)] = 0x71; // 'p' → 'q' in the stored data, so the checksum fails
    await expect(openZip(zip).read('a.txt')).rejects.toMatchObject({ code: 'corrupt' });
    const bomb = await writeZip([{ name: 'zeros', data: new Uint8Array(5_000_000) }]);
    expect(bomb.byteLength).toBeLessThan(20_000);
    await expect(openZip(bomb, { maxEntrySize: 1_000_000 }).read('zeros')).rejects.toMatchObject({ code: 'too_large' });
  });
});

/** A one-entry archive with the entry stored, built by hand. */
function storedZip(name: string, content: string): Uint8Array {
  const n = text(name);
  const data = text(content);
  const crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, n.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, n.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + n.length, true);
  end.setUint32(16, 30 + n.length + data.length, true);
  const parts = [new Uint8Array(local.buffer), n, data, new Uint8Array(central.buffer), n, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('xml', () => {
  it('reads elements, attributes, entities, CDATA and prefixed names', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><!-- note --><x:root xmlns:x="urn:x" a="1 &gt; 0" b=\'q"\' x:c="p"><x:v>&lt;A&amp;B&#65;&#x42;</x:v><w><![CDATA[<raw>]]></w><e/></x:root>',
    );
    expect(root.name).toBe('root');
    expect(root.attrs).toEqual({ a: '1 > 0', b: 'q"', c: 'p' });
    expect(root.children.map((c) => [c.name, c.text])).toEqual([
      ['v', '<A&BAB'],
      ['w', '<raw>'],
      ['e', ''],
    ]);
  });

  it('finds the end of a tag past a ">" inside quotes', () => {
    const seen: string[] = [];
    scanXml('<f a="x>y"/><g>t</g>', { open: (name, a) => seen.push(`${name}:${a.a ?? ''}`), text: (t) => seen.push(t) });
    expect(seen).toEqual(['f:x>y', 'g:', 't']);
  });

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
