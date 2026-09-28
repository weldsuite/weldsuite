/**
 * SQL fragments for sorting and filtering a list query by a CUSTOM FIELD.
 *
 * Phase 3 of the custom-fields refactor (docs/custom-fields-values-table.md).
 * Values live one-per-cell in `custom_field_values`, so unlike the old JSONB
 * blob they can drive real indexed SQL.
 *
 * These are pure fragment builders — no DB access, no Hono context. The caller
 * owns the query and splices the fragment into its own WHERE / ORDER BY.
 *
 * Both shapes are written to hit an existing index from
 * packages/core/db/src/schema/custom-field-values.ts:
 *
 *   - FILTER uses `entity_id IN (SELECT ... WHERE field_id = ? AND value_x = ?)`.
 *     Written as a semi-join rather than a correlated EXISTS so the planner can
 *     lead with the (usually far more selective) custom-field predicate instead
 *     of scanning the parent table.
 *
 *     Index caveat: the EQUALITY types (number / date / bool / ref) drive the
 *     per-type `cfv_field_<type>_idx (field_id, value_x)` composite fully. The
 *     TEXT type does not — it filters with a leading-wildcard ILIKE, which no
 *     btree index can serve, so only the `field_id` prefix narrows the scan.
 *     That is fine at current volumes but is the thing to revisit if a tenant
 *     ever accumulates a large number of text values: the fix is a trigram
 *     (pg_trgm GIN) index on `value_text`, not a change to this query shape.
 *
 *   - SORT uses a correlated scalar subquery keyed on
 *     `(entity_type, entity_id, field_id)`, which is the UNIQUE index
 *     `cfv_entity_field_idx` — an index lookup per row, and unique so it can
 *     never fan a row out into duplicates the way a naive JOIN would.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  fieldTypeToValueColumn,
  type CustomFieldDefinitionLike,
} from '@weldsuite/app-api-client/schemas/custom-fields';

/** Grid/API sort + filter keys namespace custom fields as `custom:<slug>`. */
export const CUSTOM_FIELD_KEY_PREFIX = 'custom:';

/**
 * Pull the slug out of a `custom:<slug>` key. Returns null for built-in keys,
 * so callers can branch without string-slicing at every call site.
 */
export function parseCustomFieldKey(key: string | undefined | null): string | null {
  if (!key || !key.startsWith(CUSTOM_FIELD_KEY_PREFIX)) return null;
  const slug = key.slice(CUSTOM_FIELD_KEY_PREFIX.length);
  return slug.length > 0 ? slug : null;
}

/** Physical column name in custom_field_values for a definition's field type. */
function valueColumnName(def: CustomFieldDefinitionLike): string {
  switch (fieldTypeToValueColumn(def.fieldType)) {
    case 'number':
      return 'value_number';
    case 'date':
      return 'value_date';
    case 'bool':
      return 'value_bool';
    case 'json':
      return 'value_json';
    case 'ref':
      return 'value_ref';
    case 'text':
    default:
      return 'value_text';
  }
}

/**
 * ORDER BY fragment sorting the parent rows by one custom field.
 *
 * NULLS LAST in both directions: an entity with no value for the field is
 * "empty", and empty always sorts to the bottom regardless of direction —
 * matching how the grid treats blank cells for built-in columns.
 *
 * @param entityType  custom-field entityType ('company', 'person', ...)
 * @param entityId    the parent table's id column (e.g. `companies.id`)
 * @param def         the field definition being sorted on
 * @param direction   'asc' | 'desc'
 */
export function customFieldOrderBy(
  entityType: string,
  entityId: AnyPgColumn,
  def: CustomFieldDefinitionLike & { id: string },
  direction: 'asc' | 'desc',
): SQL {
  // Column name is derived from a closed enum (never user input), so it is safe
  // to inline; every value that crosses the boundary is still parameterised.
  const column = sql.raw(valueColumnName(def));
  const inner = sql`(
    SELECT v.${column}
      FROM custom_field_values v
     WHERE v.entity_type = ${entityType}
       AND v.entity_id = ${entityId}
       AND v.field_id = ${def.id}
  )`;
  return direction === 'asc' ? sql`${inner} ASC NULLS LAST` : sql`${inner} DESC NULLS LAST`;
}

/**
 * WHERE fragment restricting parent rows to those whose custom field matches.
 *
 * Returns null when the value cannot be coerced to the field's type (e.g. a
 * non-numeric filter on a number field) — the caller should treat that as
 * "no rows match" rather than silently dropping the filter, which would
 * otherwise widen the result set instead of narrowing it.
 *
 * Semantics per type:
 *   - text-ish  : case-insensitive substring (ILIKE), matching how the grid's
 *                 built-in text filters behave
 *   - number    : exact equality
 *   - date      : same calendar day (values are stored as timestamps)
 *   - bool      : exact equality
 *   - ref       : exact id equality
 *   - json      : containment (`@>`), so a multi_select matches if it CONTAINS
 *                 the requested option
 */
export function customFieldFilter(
  entityType: string,
  entityId: AnyPgColumn,
  def: CustomFieldDefinitionLike & { id: string },
  rawValue: string | number | boolean,
): SQL | null {
  const kind = fieldTypeToValueColumn(def.fieldType);
  const column = sql.raw(valueColumnName(def));

  let predicate: SQL;
  switch (kind) {
    case 'number': {
      const n = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      if (Number.isNaN(n)) return null;
      predicate = sql`v.${column} = ${n}`;
      break;
    }
    case 'date': {
      const d = new Date(String(rawValue));
      if (Number.isNaN(d.getTime())) return null;
      // Match the whole calendar day — callers filter by date, not instant.
      predicate = sql`v.${column}::date = ${d.toISOString()}::timestamp::date`;
      break;
    }
    case 'bool': {
      const b =
        typeof rawValue === 'boolean'
          ? rawValue
          : String(rawValue) === 'true'
            ? true
            : String(rawValue) === 'false'
              ? false
              : null;
      if (b === null) return null;
      predicate = sql`v.${column} = ${b}`;
      break;
    }
    case 'json': {
      // multi_select stores string[]; containment answers "has this option".
      predicate = sql`v.${column} @> ${JSON.stringify([String(rawValue)])}::jsonb`;
      break;
    }
    case 'ref': {
      predicate = sql`v.${column} = ${String(rawValue)}`;
      break;
    }
    case 'text':
    default: {
      predicate = sql`v.${column} ILIKE ${`%${String(rawValue)}%`}`;
      break;
    }
  }

  return sql`${entityId} IN (
    SELECT v.entity_id
      FROM custom_field_values v
     WHERE v.entity_type = ${entityType}
       AND v.field_id = ${def.id}
       AND ${predicate}
  )`;
}
