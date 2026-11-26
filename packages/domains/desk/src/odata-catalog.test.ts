/**
 * The OData catalogue against the Drizzle schema: every table and column it
 * names exists (so a renamed column fails here, not in front of Power BI), the
 * types and nullability match, nothing sensitive is listed, and the JSON the
 * Rust backend reads is the catalogue itself.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as tenantSchema from '@weldsuite/db/schema';
import { SENSITIVE_COLUMNS } from '@weldsuite/db/lib/sensitive-columns';
import {
  ODATA_CATALOG,
  ODATA_ENTITY_SETS,
  isPlainColumn,
  odataCatalogJson,
  type EdmType,
} from './odata-catalog';

const tables = new Map<string, PgTable>();
for (const value of Object.values(tenantSchema)) {
  if (is(value, PgTable)) tables.set(getTableName(value), value);
}

/** The only SQL expressions (as opposed to columns) the catalogue may hold. */
const ALLOWED_EXPRESSIONS = new Set(["metadata->>'eventType'", "status = 'ACTIVE'"]);

const FORBIDDEN_COLUMN = /^(body|attachments|content|recording_.*|.*token.*|.*secret.*|.*password.*|.*credential.*|.*encrypted.*|.*api_key.*)$/;

describe('catalogue', () => {
  it('names every entity set and property once, with a string key that is never null', () => {
    expect(new Set(ODATA_ENTITY_SETS.map((s) => s.name)).size).toBe(ODATA_ENTITY_SETS.length);
    expect(new Set(ODATA_ENTITY_SETS.map((s) => s.entityType)).size).toBe(ODATA_ENTITY_SETS.length);
    for (const set of ODATA_ENTITY_SETS) {
      const names = set.properties.map((p) => p.name);
      expect(new Set(names).size, set.name).toBe(names.length);
      const key = set.properties.find((p) => p.name === set.key);
      expect(key, `${set.name} key`).toBeDefined();
      expect(key?.type).toBe('Edm.String');
      expect(key?.nullable).toBe(false);
      expect(isPlainColumn(key!.column)).toBe(true);
      for (const prop of set.properties) expect(prop.name, `${set.name}.${prop.name}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('only uses the expressions it has reviewed', () => {
    for (const set of ODATA_ENTITY_SETS) {
      for (const prop of set.properties) {
        if (!isPlainColumn(prop.column)) expect(ALLOWED_EXPRESSIONS.has(prop.column), `${set.name}.${prop.name}`).toBe(true);
      }
    }
  });

  it('refers to tables and columns that exist in the schema, with matching types', () => {
    const dataTypes: Record<EdmType, string> = {
      'Edm.String': 'string',
      'Edm.Int32': 'number',
      'Edm.Int64': 'bigint',
      'Edm.Boolean': 'boolean',
      'Edm.DateTimeOffset': 'date',
      'Edm.Double': 'number',
      'Collection(Edm.String)': 'json',
    };
    for (const set of ODATA_ENTITY_SETS) {
      const table = tables.get(set.table);
      expect(table, `table ${set.table}`).toBeDefined();
      const columns = new Map(Object.values(getTableColumns(table!)).map((col) => [col.name, col]));
      if (set.softDelete) expect(columns.has(set.softDelete), `${set.table}.${set.softDelete}`).toBe(true);
      for (const prop of set.properties) {
        if (!isPlainColumn(prop.column)) continue;
        const column = columns.get(prop.column);
        expect(column, `${set.table}.${prop.column}`).toBeDefined();
        expect(column!.dataType, `${set.name}.${prop.name} type`).toBe(dataTypes[prop.type]);
        if (prop.type !== 'Collection(Edm.String)') {
          expect(!column!.notNull, `${set.name}.${prop.name} nullable`).toBe(prop.nullable);
        }
        expect(column!.getSQLType().includes('with time zone'), `${set.name}.${prop.name} time zone`).toBe(prop.withTimeZone === true);
      }
    }
  });

  it('lists no sensitive column, message body, attachment, recording or secret', () => {
    for (const set of ODATA_ENTITY_SETS) {
      const table = tables.get(set.table)!;
      const sensitive = (SENSITIVE_COLUMNS as Record<string, readonly string[]>)[set.table] ?? [];
      const sensitiveNames = new Set(
        Object.entries(getTableColumns(table))
          .filter(([key]) => sensitive.includes(key))
          .map(([, col]) => col.name),
      );
      for (const prop of set.properties) {
        if (!isPlainColumn(prop.column)) continue;
        expect(sensitiveNames.has(prop.column), `${set.name}.${prop.name} is sensitive`).toBe(false);
        expect(FORBIDDEN_COLUMN.test(prop.column), `${set.name}.${prop.name}`).toBe(false);
      }
    }
    const messages = ODATA_ENTITY_SETS.find((s) => s.name === 'Messages')!;
    expect(messages.properties.map((p) => p.column)).not.toContain('body');
    expect(messages.properties.map((p) => p.column)).not.toContain('attachments');
  });

  it('exports itself as the JSON the Rust backend reads', () => {
    const json = odataCatalogJson();
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(ODATA_CATALOG)));
    const parsed = JSON.parse(json) as typeof ODATA_CATALOG;
    expect(parsed.namespace).toBe('WeldSuite.Desk');
    expect(parsed.container).toBe('Feed');
    expect(parsed.pageSize).toBe(1000);
    expect(parsed.entitySets.map((s) => s.name)).toEqual([
      'Conversations',
      'Messages',
      'SlaClocks',
      'Calls',
      'Teams',
      'TicketTypes',
      'Agents',
      'Problems',
      'CatalogItems',
      'Articles',
    ]);
  });
});
