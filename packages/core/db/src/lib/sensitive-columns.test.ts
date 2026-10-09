import { describe, it, expect } from 'vitest';
import { getTableColumns, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import {
  SENSITIVE_COLUMNS,
  ALL_SENSITIVE_KEYS,
  sensitiveColumnsOf,
  omitSensitive,
  omitSensitiveRows,
  scrubSensitiveKeys,
  selectableColumns,
} from './sensitive-columns';

describe('omitSensitive', () => {
  it('drops the sensitive columns of the table and keeps the rest', () => {
    const row = {
      id: 'party_1',
      displayName: 'Acme',
      tinLast4: '6789',
      sensitiveEncrypted: 'v1:ciphertext',
    };
    const safe = omitSensitive('parties', row);
    expect(safe).toEqual({ id: 'party_1', displayName: 'Acme', tinLast4: '6789' });
    expect('sensitiveEncrypted' in safe).toBe(false);
  });

  it('does not mutate the input', () => {
    const row = { id: 'e1', ssnEncrypted: 'x', salesTaxCredentialsEncrypted: 'y' };
    omitSensitive('entities', row);
    expect(row).toEqual({ id: 'e1', ssnEncrypted: 'x', salesTaxCredentialsEncrypted: 'y' });
  });

  it('drops every sensitive column of a multi-column table', () => {
    const safe = omitSensitive('entities', {
      id: 'e1',
      name: 'Acme LLC',
      ssnLast4: '1234',
      ssnEncrypted: 'a',
      salesTaxCredentialsEncrypted: 'b',
    });
    expect(safe).toEqual({ id: 'e1', name: 'Acme LLC', ssnLast4: '1234' });
  });

  it('only strips the columns of the named table', () => {
    // `credentialsEncrypted` belongs to bank_connections, not to parties.
    const row = { id: 'p1', credentialsEncrypted: 'kept' };
    expect(omitSensitive('parties', row)).toEqual(row);
  });

  it('is a no-op for a row that has none of the columns', () => {
    expect(omitSensitive('bank_accounts', { id: 'b1', name: 'Operating' })).toEqual({
      id: 'b1',
      name: 'Operating',
    });
  });

  it('works on a Drizzle column map, so it can build a select list', () => {
    const cols = getTableColumns(schema.parties);
    expect(cols.sensitiveEncrypted).toBeDefined();
    const safe = omitSensitive('parties', cols);
    expect('sensitiveEncrypted' in safe).toBe(false);
    // Everything else is still selectable.
    expect(safe.id).toBe(cols.id);
    expect(safe.tinLast4).toBe(cols.tinLast4);
    expect(Object.keys(safe).length).toBe(Object.keys(cols).length - 1);
  });
});

describe('omitSensitiveRows', () => {
  it('strips every row', () => {
    const rows = [
      { id: 'b1', accountNumberLast4: '0001', accountNumberEncrypted: 'c1' },
      { id: 'b2', accountNumberLast4: '0002', accountNumberEncrypted: 'c2' },
    ];
    expect(omitSensitiveRows('bank_accounts', rows)).toEqual([
      { id: 'b1', accountNumberLast4: '0001' },
      { id: 'b2', accountNumberLast4: '0002' },
    ]);
  });

  it('returns an empty list for no rows', () => {
    expect(omitSensitiveRows('parties', [])).toEqual([]);
  });
});

describe('selectableColumns', () => {
  it('drops the ciphertext columns of a sensitive table by its SQL name', () => {
    const columns = { id: 1, name: 2, accountNumberLast4: 3, accountNumberEncrypted: 4 };
    expect(selectableColumns('bank_accounts', columns)).toEqual({ id: 1, name: 2, accountNumberLast4: 3 });
  });

  it('also drops the extra property names asked for', () => {
    const columns = { id: 1, name: 2, secretNote: 3 };
    expect(selectableColumns('projects', columns, ['secretNote'])).toEqual({ id: 1, name: 2 });
  });

  it('is undefined (select everything) when there is nothing to leave out', () => {
    expect(selectableColumns('projects', { id: 1 })).toBeUndefined();
  });

  it('works on the real Drizzle column map', () => {
    const columns = selectableColumns('entities', getTableColumns(schema.entities));
    expect(columns).toBeDefined();
    expect('ssnEncrypted' in columns!).toBe(false);
    expect('salesTaxCredentialsEncrypted' in columns!).toBe(false);
    expect('ssnLast4' in columns!).toBe(true);
  });
});

describe('scrubSensitiveKeys', () => {
  it('strips sensitive keys at any depth, in objects and arrays', () => {
    const payload = {
      id: 'inv_1',
      party: { id: 'party_1', tinLast4: '1111', sensitiveEncrypted: 'secret' },
      lines: [{ id: 'l1' }, { id: 'l2', recipientTinEncrypted: 'tin' }],
      changes: { ssnEncrypted: { old: 'a', new: 'b' } },
    };
    expect(scrubSensitiveKeys(payload)).toEqual({
      id: 'inv_1',
      party: { id: 'party_1', tinLast4: '1111' },
      lines: [{ id: 'l1' }, { id: 'l2' }],
      changes: {},
    });
  });

  it('does not mutate the input', () => {
    const payload = { party: { sensitiveEncrypted: 'secret', id: 'p' } };
    scrubSensitiveKeys(payload);
    expect(payload.party.sensitiveEncrypted).toBe('secret');
  });

  it('returns the same reference when there is nothing to strip', () => {
    const payload = { id: 'x', nested: { a: [1, 2, { b: 3 }] } };
    expect(scrubSensitiveKeys(payload)).toBe(payload);
  });

  it('leaves non-plain values alone', () => {
    const when = new Date('2026-01-01');
    const out = scrubSensitiveKeys({ when, n: 1, s: 's', nil: null, u: undefined });
    expect(out.when).toBe(when);
    expect(out.n).toBe(1);
  });

  it('passes scalars and null through', () => {
    expect(scrubSensitiveKeys(null)).toBeNull();
    expect(scrubSensitiveKeys('x')).toBe('x');
    expect(scrubSensitiveKeys(5)).toBe(5);
  });

  it('survives a cyclic value', () => {
    const a: Record<string, unknown> = { id: 'a' };
    a.self = a;
    expect(() => scrubSensitiveKeys(a)).not.toThrow();
  });
});

describe('SENSITIVE_COLUMNS stays in step with the schema', () => {
  const tables = Object.values(schema).filter((v) => is(v, PgTable)) as unknown as PgTable[];
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));

  it('lists only columns that exist', () => {
    for (const [tableName, keys] of Object.entries(SENSITIVE_COLUMNS)) {
      const table = byName.get(tableName);
      expect(table, `table ${tableName} is in the schema`).toBeDefined();
      const columns = getTableColumns(table as PgTable) as Record<string, unknown>;
      for (const key of keys) {
        expect(columns[key], `${tableName}.${key} is a column`).toBeDefined();
      }
    }
  });

  it('lists every `*_encrypted` column, so a new ciphertext column cannot ship unguarded', () => {
    // Master-DB tables (`workspaces.admin_password_encrypted`) are not in this
    // schema index. Add a column here only with a reason: it must never reach a
    // generic response either.
    const handledElsewhere = new Set<string>();

    const unguarded: string[] = [];
    for (const table of tables) {
      const { name } = getTableConfig(table);
      const listed: readonly string[] = (SENSITIVE_COLUMNS as Record<string, readonly string[]>)[name] ?? [];
      for (const [key, column] of Object.entries(getTableColumns(table))) {
        // Ciphertext is text; `is_encrypted` flags are booleans and are fine.
        if (!column.name.endsWith('_encrypted') || column.dataType !== 'string') continue;
        if (listed.includes(key) || handledElsewhere.has(`${name}.${key}`)) continue;
        unguarded.push(`${name}.${key}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('exposes the lookup helpers consistently', () => {
    expect(sensitiveColumnsOf('parties')).toEqual(['sensitiveEncrypted']);
    expect(ALL_SENSITIVE_KEYS.has('ssnEncrypted')).toBe(true);
    expect(ALL_SENSITIVE_KEYS.has('id')).toBe(false);
  });
});
