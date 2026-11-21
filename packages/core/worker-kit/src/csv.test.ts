import { describe, expect, it } from 'vitest';
import { csvCell, csvResponse, toCsv } from './csv';

describe('csvCell', () => {
  it('writes numbers, booleans and empties plainly', () => {
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('puts a quote in front of text a spreadsheet would run as a formula', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-cmd|x')).toBe("'-cmd|x");
    expect(csvCell('\tx')).toBe("'\tx");
  });

  it('leaves a text that is a plain number alone', () => {
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell('a=b')).toBe('a=b');
  });
});

describe('toCsv', () => {
  it('starts with a byte order mark, uses CRLF and ends with a line break', () => {
    const csv = toCsv(['label', 'value'], [['Ann', 3], ['Bob, Jr.', null]]);
    expect(csv).toBe('﻿label,value\r\nAnn,3\r\n"Bob, Jr.",\r\n');
  });

  it('writes just the header for no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('﻿a,b\r\n');
  });
});

describe('csvResponse', () => {
  it('answers a UTF-8 CSV download with a safe filename', async () => {
    const res = csvResponse('x', 'welddesk overview/7.csv');
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="welddesk_overview_7.csv"');
    expect(await res.text()).toBe('x');
  });
});
