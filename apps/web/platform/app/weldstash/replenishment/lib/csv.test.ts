import { describe, expect, it } from 'vitest';
import {
  chunkRows,
  detectDelimiter,
  guessMapping,
  isMappingComplete,
  mapRows,
  parseCsv,
  parseDate,
  parseQuantity,
} from './csv';

describe('parseCsv', () => {
  it('parses a comma file with CRLF line ends and a BOM', () => {
    const rows = parseCsv('﻿date,sku,qty\r\n2026-01-05,A-1,3\r\n2026-01-06,B-2,4\r\n');
    expect(rows).toEqual([
      ['date', 'sku', 'qty'],
      ['2026-01-05', 'A-1', '3'],
      ['2026-01-06', 'B-2', '4'],
    ]);
  });

  it('keeps delimiters, doubled quotes and newlines inside quoted fields', () => {
    const rows = parseCsv('a,b\n"x, y","say ""hi""\nthere"\n');
    expect(rows[1]).toEqual(['x, y', 'say "hi"\nthere']);
  });

  it('detects semicolons and tabs', () => {
    expect(detectDelimiter('date;sku;qty\n1;2;3')).toBe(';');
    expect(detectDelimiter('date\tsku\tqty')).toBe('\t');
    expect(detectDelimiter('single')).toBe(',');
    expect(parseCsv('date;sku\n2026-01-01;A')).toEqual([['date', 'sku'], ['2026-01-01', 'A']]);
  });

  it('ignores a delimiter inside quotes when detecting', () => {
    expect(detectDelimiter('"a;b;c",d')).toBe(',');
  });

  it('drops empty rows and keeps a last row with no final newline', () => {
    expect(parseCsv('a,b\n\n,\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('guessMapping', () => {
  it('maps English headers', () => {
    const m = guessMapping(['Order Date', 'SKU', 'Quantity', 'Warehouse', 'Order Number']);
    expect(m).toEqual({ date: 0, sku: 1, quantity: 2, warehouseCode: 3, reference: 4 });
    expect(isMappingComplete(m)).toBe(true);
  });

  it('maps Dutch headers', () => {
    const m = guessMapping(['Datum', 'Artikelnummer', 'Aantal']);
    expect(m).toMatchObject({ date: 0, sku: 1, quantity: 2, warehouseCode: -1, reference: -1 });
  });

  it('leaves unknown columns unmapped', () => {
    const m = guessMapping(['foo', 'bar']);
    expect(isMappingComplete(m)).toBe(false);
  });
});

describe('parseDate', () => {
  it('reads ISO dates, with or without a time', () => {
    expect(parseDate('2026-03-05')).toBe('2026-03-05');
    expect(parseDate('2026-3-5')).toBe('2026-03-05');
    expect(parseDate('2026-03-05T10:00:00Z')).toBe('2026-03-05');
    expect(parseDate('2026/03/05')).toBe('2026-03-05');
  });

  it('reads numeric dates day first by default', () => {
    expect(parseDate('05-03-2026')).toBe('2026-03-05');
    expect(parseDate('5/3/2026', 'dmy')).toBe('2026-03-05');
  });

  it('reads month first when asked, and when auto sees a day above 12 in the middle', () => {
    expect(parseDate('03/05/2026', 'mdy')).toBe('2026-03-05');
    expect(parseDate('03/25/2026')).toBe('2026-03-25');
    expect(parseDate('25/03/2026')).toBe('2026-03-25');
  });

  it('rejects impossible and unreadable dates', () => {
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('31-04-2026')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('05-03-26')).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('reads whole numbers, with signs and zero decimals', () => {
    expect(parseQuantity('12')).toBe(12);
    expect(parseQuantity(' 7 ')).toBe(7);
    expect(parseQuantity('-2')).toBe(-2);
    expect(parseQuantity('5.0')).toBe(5);
    expect(parseQuantity('5,00')).toBe(5);
  });

  it('rejects fractions and text', () => {
    expect(parseQuantity('1.5')).toBeNull();
    expect(parseQuantity('1,5')).toBeNull();
    expect(parseQuantity('many')).toBeNull();
    expect(parseQuantity('')).toBeNull();
  });
});

describe('mapRows', () => {
  const mapping = { date: 0, sku: 1, quantity: 2, warehouseCode: 3, reference: -1 };

  it('maps valid rows and reports the bad ones with their file line', () => {
    const result = mapRows(
      [
        ['2026-01-05', 'A-1', '3', 'MAIN'],
        ['nope', 'A-1', '3', ''],
        ['2026-01-07', '', '3', ''],
        ['2026-01-08', 'B-2', 'x', ''],
        ['2026-01-02', 'B-2', '4', ''],
      ],
      mapping,
    );
    expect(result.rows).toEqual([
      { date: '2026-01-05', sku: 'A-1', quantity: 3, warehouseCode: 'MAIN' },
      { date: '2026-01-02', sku: 'B-2', quantity: 4 },
    ]);
    expect(result.errors).toEqual([
      { line: 3, code: 'date', value: 'nope' },
      { line: 4, code: 'sku', value: '' },
      { line: 5, code: 'quantity', value: 'x' },
    ]);
    expect(result.dateFrom).toBe('2026-01-02');
    expect(result.dateTo).toBe('2026-01-05');
    expect(result.distinctSkus).toBe(2);
  });

  it('numbers lines from the first data line given', () => {
    const result = mapRows([['bad', 'A', '1']], mapping, 'auto', 1);
    expect(result.errors[0].line).toBe(1);
  });

  it('carries a reference column when mapped', () => {
    const result = mapRows([['2026-01-05', 'A', '1', '', 'SO-9']], { ...mapping, reference: 4 });
    expect(result.rows[0].reference).toBe('SO-9');
  });
});

describe('chunkRows', () => {
  it('splits into chunks of at most 1,000 by default', () => {
    const rows = Array.from({ length: 2500 }, (_, i) => i);
    const chunks = chunkRows(rows);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
  });

  it('returns no chunk for no rows', () => {
    expect(chunkRows([])).toEqual([]);
  });
});
