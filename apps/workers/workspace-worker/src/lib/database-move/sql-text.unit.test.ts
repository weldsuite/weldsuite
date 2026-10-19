/**
 * Pins the exact SQL the page reader and writer generate, and the one regex
 * that rewrites a constraint definition, so the code building them can be
 * refactored without a character moving. The pure counterpart of
 * sql-text.pglite.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildInsertStatement, buildReadStatement, stripNotValid, type TableInfo } from './index';

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

const lines = table({
  name: 'order_lines',
  columns: [
    { name: 'order_id', type: 'character varying(30)', json: false },
    { name: 'line_no', type: 'integer', json: false },
    { name: 'meta', type: 'jsonb', json: true },
    { name: 'we"ird', type: 'numeric(20,6)', json: false },
  ],
  primaryKey: ['order_id', 'line_no'],
});

describe('buildReadStatement text', () => {
  it('first page of a single-column key', () => {
    expect(buildReadStatement(table({ name: 'accounts' }), null, 10, 4096)).toMatchInlineSnapshot(`
      {
        "params": [],
        "text": "
      SELECT z.body, z.k0, z.total::text AS total
      FROM (
        SELECT y.body, y.k0,
               row_number() OVER w AS rn,
               sum(octet_length(y.body)) OVER w AS run,
               count(*) OVER () AS total
        FROM (
          SELECT row_to_json(x)::text AS body, x."id"::text AS k0, x."id" AS o0
          FROM (
            SELECT t."id", t."data"::text AS "data"
            FROM "public"."accounts" t
            
            ORDER BY t."id"
            LIMIT 11
          ) x
        ) y
        WINDOW w AS (ORDER BY o0 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      ) z
      WHERE z.rn <= 10 AND (z.rn = 1 OR z.run <= 4096)
      ORDER BY z.rn",
      }
    `);
  });

  it('page after a cursor on a composite key, json columns read as text', () => {
    expect(buildReadStatement(lines, ['ord_1', '2'], 25, 12345)).toMatchInlineSnapshot(`
      {
        "params": [
          "ord_1",
          "2",
        ],
        "text": "
      SELECT z.body, z.k0, z.k1, z.total::text AS total
      FROM (
        SELECT y.body, y.k0, y.k1,
               row_number() OVER w AS rn,
               sum(octet_length(y.body)) OVER w AS run,
               count(*) OVER () AS total
        FROM (
          SELECT row_to_json(x)::text AS body, x."order_id"::text AS k0, x."line_no"::text AS k1, x."order_id" AS o0, x."line_no" AS o1
          FROM (
            SELECT t."order_id", t."line_no", t."meta"::text AS "meta", t."we""ird"
            FROM "public"."order_lines" t
            WHERE (t."order_id", t."line_no") > ($1, $2)
            ORDER BY t."order_id", t."line_no"
            LIMIT 26
          ) x
        ) y
        WINDOW w AS (ORDER BY o0, o1 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      ) z
      WHERE z.rn <= 25 AND (z.rn = 1 OR z.run <= 12345)
      ORDER BY z.rn",
      }
    `);
  });

  it('first page of a composite key', () => {
    expect(buildReadStatement(lines, null, 500, 1_000_000).text).toMatchInlineSnapshot(`
      "
      SELECT z.body, z.k0, z.k1, z.total::text AS total
      FROM (
        SELECT y.body, y.k0, y.k1,
               row_number() OVER w AS rn,
               sum(octet_length(y.body)) OVER w AS run,
               count(*) OVER () AS total
        FROM (
          SELECT row_to_json(x)::text AS body, x."order_id"::text AS k0, x."line_no"::text AS k1, x."order_id" AS o0, x."line_no" AS o1
          FROM (
            SELECT t."order_id", t."line_no", t."meta"::text AS "meta", t."we""ird"
            FROM "public"."order_lines" t
            
            ORDER BY t."order_id", t."line_no"
            LIMIT 501
          ) x
        ) y
        WINDOW w AS (ORDER BY o0, o1 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      ) z
      WHERE z.rn <= 500 AND (z.rn = 1 OR z.run <= 1000000)
      ORDER BY z.rn"
    `);
  });
});

describe('buildInsertStatement text', () => {
  it('casts json columns back and declares them as text', () => {
    expect(buildInsertStatement(lines, '[{"order_id":"a"}]')).toMatchInlineSnapshot(`
      {
        "params": [
          "[{"order_id":"a"}]",
        ],
        "text": "
      WITH ins AS (
        INSERT INTO "public"."order_lines" ("order_id", "line_no", "meta", "we""ird")
        SELECT x."order_id", x."line_no", x."meta"::jsonb, x."we""ird"
        FROM json_to_recordset($1::json) AS x("order_id" character varying(30), "line_no" integer, "meta" text, "we""ird" numeric(20,6))
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::text AS inserted FROM ins",
      }
    `);
  });
});

describe('stripNotValid', () => {
  /** The expression `stripNotValid` replaced: super-linear on a long run of whitespace. */
  const reference = (definition: string): string => definition.replace(/\s+NOT VALID\s*$/i, '');

  const tokens = ['a', ' ', '\n', 'NOT VALID', 'not valid', 'Not', 'VALID', ' ', '﻿'];

  function* sequences(maxTokens: number): Generator<string> {
    let layer: string[] = [''];
    for (let n = 0; n < maxTokens; n++) {
      const next: string[] = [];
      for (const prefix of layer) {
        for (const token of tokens) next.push(prefix + token);
      }
      yield* next;
      layer = next;
    }
  }

  it('removes a trailing NOT VALID and the whitespace around it, as the expression it replaced did', () => {
    expect(stripNotValid('FOREIGN KEY (a) REFERENCES t(id) NOT VALID')).toBe('FOREIGN KEY (a) REFERENCES t(id)');
    expect(stripNotValid('FOREIGN KEY (a) REFERENCES t(id) not valid  \n')).toBe('FOREIGN KEY (a) REFERENCES t(id)');
    expect(stripNotValid('x\t  Not Valid ')).toBe('x');
    expect(stripNotValid(' NOT VALID')).toBe('');
  });

  it('leaves a definition without a trailing NOT VALID untouched', () => {
    for (const definition of [
      '',
      'NOT VALID',
      'xNOT VALID',
      'NOT  VALID',
      'a NOT VALID b',
      'a NOT VALID.',
      'FOREIGN KEY (a) REFERENCES t(id) ON DELETE CASCADE',
    ]) {
      expect(stripNotValid(definition)).toBe(definition);
    }
  });

  it('only strips the last NOT VALID', () => {
    expect(stripNotValid('a NOT VALID NOT VALID')).toBe('a NOT VALID');
  });

  it('agrees with the expression it replaced on every combination of up to five pieces', () => {
    let checked = 0;
    for (const input of sequences(5)) {
      expect(stripNotValid(input)).toBe(reference(input));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50_000);
  });

  it('stays linear on a long run of whitespace', () => {
    const run = ' '.repeat(300_000);
    expect(stripNotValid(`a${run}b`)).toBe(`a${run}b`);
    expect(stripNotValid(`a${run}`)).toBe(`a${run}`);
    expect(stripNotValid(`a${run}NOT VALID${run}`)).toBe('a');
    expect(stripNotValid(`${run}NOT VALID`)).toBe('');
    expect(stripNotValid(' NOT VALID'.repeat(30_000))).toBe(' NOT VALID'.repeat(29_999));
    expect(stripNotValid(`${run}NOT${run}VALID`)).toBe(`${run}NOT${run}VALID`);
  });
});
