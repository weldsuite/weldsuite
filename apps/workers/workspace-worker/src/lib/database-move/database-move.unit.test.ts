/**
 * Pure parts of the move engine: quoting, page sizing, copy planning, the SQL
 * the page reader and writer generate, checksum comparison. No database.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_ROWS,
  MIN_PAGE_ROWS,
  buildInsertStatement,
  buildReadStatement,
  compareChecksums,
  estimateRowBytes,
  pageSizeFor,
  planCopy,
  qualifiedTable,
  quoteIdent,
  quoteLiteral,
  sourceUnchanged,
  TableWithoutPrimaryKeyError,
  type ChecksumMap,
  type TableInfo,
} from './index';

function table(partial: Partial<TableInfo> & { name: string }): TableInfo {
  return {
    columns: [
      { name: 'id', type: 'character varying(30)', json: false },
      { name: 'data', type: 'jsonb', json: true },
    ],
    primaryKey: ['id'],
    estimatedRows: 10,
    avgRowBytes: 100,
    ...partial,
  };
}

describe('quoting', () => {
  it('doubles embedded double quotes and wraps identifiers', () => {
    expect(quoteIdent('plain')).toBe('"plain"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteIdent('a b;--')).toBe('"a b;--"');
    expect(qualifiedTable('t"x')).toBe('"public"."t""x"');
  });

  it('doubles single quotes in literals', () => {
    expect(quoteLiteral("o'neil")).toBe("'o''neil'");
  });

  it('refuses NUL bytes', () => {
    expect(() => quoteIdent('a\0b')).toThrow();
    expect(() => quoteLiteral('a\0b')).toThrow();
  });
});

describe('pageSizeFor', () => {
  it('aims at ~1 MiB per page', () => {
    expect(pageSizeFor({ avgRowBytes: 2048 })).toBe(512);
    expect(pageSizeFor({ avgRowBytes: 1024 })).toBe(1024);
  });

  it('clamps to 50..5000 rows', () => {
    expect(pageSizeFor({ avgRowBytes: 10 })).toBe(MAX_PAGE_ROWS);
    expect(pageSizeFor({ avgRowBytes: 1_000_000 })).toBe(MIN_PAGE_ROWS);
    expect(MIN_PAGE_ROWS).toBe(50);
    expect(MAX_PAGE_ROWS).toBe(5000);
  });

  it('survives a zero width', () => {
    expect(pageSizeFor({ avgRowBytes: 0 })).toBe(MAX_PAGE_ROWS);
  });
});

describe('estimateRowBytes', () => {
  it('prefers column statistics, then heap density, then a default, and adds JSON key overhead', () => {
    const columnNames = ['id', 'data']; // overhead = (2 + 6) + (4 + 6) = 18
    expect(estimateRowBytes({ statsWidth: 100, reltuples: 1000, relpages: 50, columnNames })).toBe(118);
    expect(estimateRowBytes({ statsWidth: null, reltuples: 1000, relpages: 50, columnNames })).toBe(Math.ceil((50 * 8192) / 1000 + 18));
    expect(estimateRowBytes({ statsWidth: null, reltuples: null, relpages: 0, columnNames })).toBe(256 + 18);
    expect(estimateRowBytes({ statsWidth: null, reltuples: 0, relpages: 0, columnNames })).toBe(256 + 18);
  });
});

describe('planCopy', () => {
  const tables = [
    table({ name: 'big', estimatedRows: 1_000_000, avgRowBytes: 200 }),
    table({ name: 'tiny', estimatedRows: 5, avgRowBytes: 50 }),
    table({ name: 'unanalysed', estimatedRows: null, avgRowBytes: 256 }),
    table({ name: 'medium', estimatedRows: 10_000, avgRowBytes: 400 }),
    table({ name: 'empty', estimatedRows: 0, avgRowBytes: 100 }),
  ];

  it('drops empty tables and orders the rest smallest first, biggest last', () => {
    const plan = planCopy({ tables }, ['big', 'tiny', 'unanalysed', 'medium']);
    expect(plan.tables.map((t) => t.name)).toEqual(['unanalysed', 'tiny', 'medium', 'big']);
    expect(plan.skippedEmpty).toBe(1);
  });

  it('breaks ties by name so the order is stable', () => {
    const same = [table({ name: 'b' }), table({ name: 'a' }), table({ name: 'c' })];
    expect(planCopy({ tables: same }, ['c', 'b', 'a']).tables.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('ignores census names that are not in the catalog', () => {
    expect(planCopy({ tables }, ['tiny', 'ghost']).tables.map((t) => t.name)).toEqual(['tiny']);
  });

  it('is JSON-serialisable', () => {
    const plan = planCopy({ tables }, ['tiny', 'big']);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it('fails before copying anything when a non-empty table has no primary key', () => {
    const keyless = [table({ name: 'keyless', primaryKey: [] }), table({ name: 'ok' })];
    expect(() => planCopy({ tables: keyless }, ['keyless', 'ok'])).toThrow(TableWithoutPrimaryKeyError);
    // An empty keyless table is not copied, so it is fine.
    expect(planCopy({ tables: keyless }, ['ok']).tables.map((t) => t.name)).toEqual(['ok']);
  });
});

describe('buildReadStatement', () => {
  const single = table({ name: 'a"b' });
  const composite = table({
    name: 'lines',
    primaryKey: ['order_id', 'line_no'],
    columns: [
      { name: 'order_id', type: 'text', json: false },
      { name: 'line_no', type: 'integer', json: false },
      { name: 'meta', type: 'json', json: true },
    ],
  });

  it('first page has no WHERE and no parameters', () => {
    const stmt = buildReadStatement(single, null, 10, 4096);
    expect(stmt.params).toEqual([]);
    expect(stmt.text).not.toContain('WHERE (');
    expect(stmt.text).toContain('LIMIT 11'); // page + one peek row
    expect(stmt.text).toContain('"public"."a""b"');
  });

  it('uses a row-value comparison on the whole key after a cursor, with the cursor values as parameters', () => {
    const stmt = buildReadStatement(composite, ['ord_1', '2'], 10, 4096);
    expect(stmt.params).toEqual(['ord_1', '2']);
    expect(stmt.text).toContain('WHERE (t."order_id", t."line_no") > ($1, $2)');
    expect(stmt.text).toContain('ORDER BY t."order_id", t."line_no"');
  });

  it('casts json columns to text and leaves the others alone', () => {
    const stmt = buildReadStatement(composite, null, 10, 4096);
    expect(stmt.text).toContain('t."meta"::text AS "meta"');
    expect(stmt.text).not.toContain('t."order_id"::text AS "order_id"');
  });

  it('applies the row cap and the byte cap', () => {
    const stmt = buildReadStatement(single, null, 25, 12345);
    expect(stmt.text).toContain('z.rn <= 25');
    expect(stmt.text).toContain('z.run <= 12345');
  });

  it('never interpolates the cursor into the SQL text', () => {
    const stmt = buildReadStatement(single, [`x'; DROP TABLE users; --`], 10, 4096);
    expect(stmt.text).not.toContain('DROP TABLE');
    expect(stmt.params).toEqual([`x'; DROP TABLE users; --`]);
  });

  it('rejects keyless tables and bad sizes', () => {
    expect(() => buildReadStatement(table({ name: 'k', primaryKey: [] }), null, 10, 4096)).toThrow(TableWithoutPrimaryKeyError);
    expect(() => buildReadStatement(single, null, 0, 4096)).toThrow();
    expect(() => buildReadStatement(single, null, 10, 1.5)).toThrow();
  });
});

describe('buildInsertStatement', () => {
  const t = table({
    name: 'docs',
    columns: [
      { name: 'id', type: 'character varying(30)', json: false },
      { name: 'amount', type: 'numeric(20,6)', json: false },
      { name: 'body', type: 'jsonb', json: true },
    ],
  });

  it('unpacks the JSON array with declared column types, json columns as text cast back to their type', () => {
    const stmt = buildInsertStatement(t, '[{"id":"a"}]');
    expect(stmt.params).toEqual(['[{"id":"a"}]']);
    expect(stmt.text).toContain('INSERT INTO "public"."docs" ("id", "amount", "body")');
    expect(stmt.text).toContain('SELECT x."id", x."amount", x."body"::jsonb');
    expect(stmt.text).toContain('json_to_recordset($1::json) AS x("id" character varying(30), "amount" numeric(20,6), "body" text)');
    expect(stmt.text).toContain('ON CONFLICT DO NOTHING');
  });

  it('passes the payload as a parameter, never in the SQL text', () => {
    const stmt = buildInsertStatement(t, `[{"id":"'; DROP TABLE docs; --"}]`);
    expect(stmt.text).not.toContain('DROP TABLE');
  });
});

describe('compareChecksums and sourceUnchanged', () => {
  const base: ChecksumMap = {
    a: { count: 3, hash: '100' },
    b: { count: 0, hash: '0' },
    big: { count: 9_000_000, hash: null },
  };

  it('is ok when counts and hashes agree, and says which tables were only counted', () => {
    const result = compareChecksums(base, structuredClone(base));
    expect(result.ok).toBe(true);
    expect(result.tables.find((t) => t.table === 'big')?.hashCompared).toBe(false);
    expect(result.tables.find((t) => t.table === 'a')?.hashCompared).toBe(true);
  });

  it('flags count, hash and missing tables, with the reason', () => {
    const other: ChecksumMap = {
      a: { count: 3, hash: '101' },
      b: { count: 1, hash: '7' },
      extra: { count: 0, hash: '0' },
    };
    const result = compareChecksums(base, other);
    expect(result.ok).toBe(false);
    expect(Object.fromEntries(result.tables.map((t) => [t.table, t.reason]))).toEqual({
      a: 'hash',
      b: 'count',
      big: 'missing-on-target',
      extra: 'missing-on-source',
    });
    expect(result.mismatched).toEqual(['a', 'b', 'big', 'extra']);
  });

  it('sourceUnchanged is a self-comparison of two readings', () => {
    expect(sourceUnchanged(base, structuredClone(base))).toEqual({ unchanged: true, changedTables: [] });
    expect(sourceUnchanged(base, { ...base, a: { count: 4, hash: '200' } })).toEqual({
      unchanged: false,
      changedTables: ['a'],
    });
  });
});
