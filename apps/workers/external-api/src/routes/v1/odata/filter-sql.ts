/**
 * The `$filter` AST as SQL. Identifiers and expressions come from the
 * catalogue only; every value from the request is a bound parameter with an
 * explicit cast, so no input reaches the statement as text.
 *
 * Comparisons follow OData's null rules: a comparison with a null column is
 * false (`COALESCE(..., false)`), so `not` of it is true, and `ne` is
 * `IS DISTINCT FROM`.
 */

import { sql, type SQL } from 'drizzle-orm';
import { isPlainColumn, type EdmType, type ODataEntitySet, type ODataProperty } from '@weldsuite/desk-domain/odata-catalog';
import { escapeLike } from '../../../lib/search';
import type { CmpOp, FilterNode, Literal, TextFn } from './filter';

const SQL_OPS: Record<Exclude<CmpOp, 'eq' | 'ne'>, SQL> = {
  gt: sql.raw('>'),
  ge: sql.raw('>='),
  lt: sql.raw('<'),
  le: sql.raw('<='),
};

/** The property's value as SQL; timestamps are always the UTC `timestamp`. */
export function propExpr(set: ODataEntitySet, prop: ODataProperty): SQL {
  const column = isPlainColumn(prop.column)
    ? sql`${sql.identifier(set.table)}.${sql.identifier(prop.column)}`
    : sql`(${sql.raw(prop.column)})`;
  return prop.withTimeZone ? sql`(${column} AT TIME ZONE 'UTC')` : column;
}

/** A literal as a bound parameter, cast to the type it is compared with. */
function param(type: EdmType, lit: Literal): SQL {
  switch (lit.type) {
    case 'string':
      return sql`${lit.value}::text`;
    case 'boolean':
      return sql`${lit.value}::boolean`;
    case 'datetime':
      return sql`${lit.ts}::timestamp`;
    case 'int':
    case 'double':
      if (type === 'Edm.Int64') return sql`${lit.value}::bigint`;
      if (type === 'Edm.Double') return sql`${lit.value}::float8`;
      return sql`${lit.value}::int`;
    default:
      throw new Error('a null literal has no parameter');
  }
}

export { escapeLike };

const like = (expr: SQL, pattern: string): SQL => sql`COALESCE(${expr} LIKE ${pattern}::text ESCAPE '\\', false)`;

function compare(node: Extract<FilterNode, { kind: 'cmp' }>, set: ODataEntitySet): SQL {
  const { op, prop, lit } = node;
  const column = propExpr(set, prop);
  if (lit.type === 'null') return op === 'eq' ? sql`${column} IS NULL` : sql`${column} IS NOT NULL`;

  if (node.fn) {
    const part = sql`extract(${sql.raw(node.fn)} from ${column})::int`;
    const value = param('Edm.Int32', lit);
    if (op === 'eq') return sql`COALESCE(${part} = ${value}, false)`;
    if (op === 'ne') return sql`${part} IS DISTINCT FROM ${value}`;
    return sql`COALESCE(${part} ${SQL_OPS[op]} ${value}, false)`;
  }

  // A bare date means the day: `eq` / `ne` match all of it, the others compare with its midnight.
  if (lit.type === 'datetime' && lit.dayEnd !== undefined && (op === 'eq' || op === 'ne')) {
    const inDay = sql`COALESCE(${column} >= ${lit.ts}::timestamp AND ${column} < ${lit.dayEnd}::timestamp, false)`;
    return op === 'eq' ? inDay : sql`NOT ${inDay}`;
  }

  const value = param(prop.type, lit);
  if (op === 'eq') return sql`COALESCE(${column} = ${value}, false)`;
  if (op === 'ne') return sql`${column} IS DISTINCT FROM ${value}`;
  return sql`COALESCE(${column} ${SQL_OPS[op]} ${value}, false)`;
}

/** The conditions of `args` in brackets, with `separator` between them. */
function joined(args: FilterNode[], set: ODataEntitySet, separator: SQL): SQL {
  const conditions = sql.join(
    args.map((arg) => filterToSql(arg, set)),
    separator,
  );
  return sql`(${conditions})`;
}

/** The LIKE pattern of a text function over an escaped value. */
function likePattern(fn: TextFn, escaped: string): string {
  if (fn === 'contains') return `%${escaped}%`;
  if (fn === 'startswith') return `${escaped}%`;
  return `%${escaped}`;
}

/** The WHERE condition for a parsed `$filter`. */
export function filterToSql(node: FilterNode, set: ODataEntitySet): SQL {
  switch (node.kind) {
    case 'and':
      return joined(node.args, set, sql` AND `);
    case 'or':
      return joined(node.args, set, sql` OR `);
    case 'not':
      return sql`(NOT ${filterToSql(node.arg, set)})`;
    case 'cmp':
      return compare(node, set);
    case 'text':
      return like(propExpr(set, node.prop), likePattern(node.fn, escapeLike(node.value)));
    case 'any':
      return sql`COALESCE(${propExpr(set, node.prop)} @> jsonb_build_array(${node.value}::text), false)`;
  }
}
