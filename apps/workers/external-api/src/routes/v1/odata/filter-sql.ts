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
import { isPlainColumn, type EdmType, type ODataEntitySet, type ODataProperty } from './catalog';
import type { CmpOp, FilterNode, Literal } from './filter';

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

/** `%`, `_` and the escape character itself, so a LIKE pattern matches the text literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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

/** The WHERE condition for a parsed `$filter`. */
export function filterToSql(node: FilterNode, set: ODataEntitySet): SQL {
  switch (node.kind) {
    case 'and':
      return sql`(${sql.join(node.args.map((arg) => filterToSql(arg, set)), sql` AND `)})`;
    case 'or':
      return sql`(${sql.join(node.args.map((arg) => filterToSql(arg, set)), sql` OR `)})`;
    case 'not':
      return sql`(NOT ${filterToSql(node.arg, set)})`;
    case 'cmp':
      return compare(node, set);
    case 'text': {
      const escaped = escapeLike(node.value);
      const pattern =
        node.fn === 'contains' ? `%${escaped}%` : node.fn === 'startswith' ? `${escaped}%` : `%${escaped}`;
      return like(propExpr(set, node.prop), pattern);
    }
    case 'any':
      return sql`COALESCE(${propExpr(set, node.prop)} @> jsonb_build_array(${node.value}::text), false)`;
  }
}
