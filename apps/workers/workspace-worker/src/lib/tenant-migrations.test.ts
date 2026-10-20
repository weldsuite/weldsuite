import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../generated/tenant-migrations', () => ({
  MIGRATION_JOURNAL: [
    { idx: 0, tag: '0000_first', when: 100 },
    { idx: 1, tag: '0001_second', when: 200 },
    { idx: 2, tag: '0002_third', when: 150 }, // merged with an older timestamp
  ],
  MIGRATION_SQL: {
    '0000_first': 'CREATE TABLE a (id int);',
    '0001_second': 'CREATE TABLE b (id int);',
    '0002_third': 'CREATE TABLE c (id int);--> statement-breakpoint\nCREATE INDEX c_id ON c (id);',
  },
  MIGRATION_HASHES: { '0000_first': 'h0', '0001_second': 'h1', '0002_third': 'h2' },
}));

import { applyTenantMigrations, bundledJournalEntries, TenantMigrationError } from './tenant-migrations';

type Row = { tag: string | null; hash: string | null; created_at: string | null };

const dialect = new PgDialect();

/** A db whose journal holds `rows`; records every statement, and fails the ones `fail` matches. */
type TenantDb = Parameters<typeof applyTenantMigrations>[0];

function fakeDb(rows: Row[], fail?: (text: string) => unknown) {
  const executed: Array<{ text: string; params: unknown[] }> = [];
  const db = {
    async execute(query: SQL) {
      const { sql: text, params } = dialect.sqlToQuery(query);
      executed.push({ text, params });
      const error = fail?.(text);
      if (error) throw error;
      if (text.startsWith('SELECT tag, hash, created_at')) return { rows };
      return { rows: [] };
    },
  };
  return { db: db as unknown as TenantDb, executed, statements: () => executed.map((e) => e.text) };
}

describe('applyTenantMigrations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds the tag column a drizzle-made journal lacks', async () => {
    const { db, statements } = fakeDb([]);
    await applyTenantMigrations(db);
    expect(statements()).toContain('ALTER TABLE "__drizzle_migrations" ADD COLUMN IF NOT EXISTS tag text');
  });

  it('applies nothing to a database drizzle already migrated (rows with a hash or created_at, no tag)', async () => {
    const { db, statements } = fakeDb([
      { tag: null, hash: 'h0', created_at: '100' },
      { tag: null, hash: 'edited-since', created_at: '200' },
      { tag: null, hash: 'h2', created_at: '150' },
    ]);
    expect(await applyTenantMigrations(db)).toEqual({ applied: 0, skipped: 3, remaining: 0 });
    expect(statements().some((text) => text.startsWith('CREATE TABLE a') || text.startsWith('INSERT'))).toBe(false);
  });

  it('applies the migration drizzle skipped, and records it once with its tag', async () => {
    const { db, executed } = fakeDb([
      { tag: null, hash: 'h0', created_at: '100' },
      { tag: '0001_second', hash: 'h1', created_at: '200' },
    ]);
    expect(await applyTenantMigrations(db)).toEqual({ applied: 1, skipped: 2, remaining: 0 });
    const ran = executed.map((e) => e.text);
    expect(ran).toContain('CREATE TABLE c (id int);');
    expect(ran).toContain('CREATE INDEX c_id ON c (id);');
    expect(ran).not.toContain('CREATE TABLE a (id int);');
    const inserts = executed.filter((e) => e.text.startsWith('INSERT INTO "__drizzle_migrations"'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toEqual(['h2', 150, '0002_third']);
  });

  it('names the migration and statement that failed, with the SQLSTATE only, and records nothing for it', async () => {
    const driverError = Object.assign(new Error('relation "c_id" already exists, value=secret'), { code: '42P07' });
    const { db, executed } = fakeDb(
      [
        { tag: '0000_first', hash: 'h0', created_at: '100' },
        { tag: '0001_second', hash: 'h1', created_at: '200' },
      ],
      (text) => (text.startsWith('CREATE INDEX c_id') ? driverError : undefined),
    );
    const error = await applyTenantMigrations(db).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantMigrationError);
    expect(error).toMatchObject({ tag: '0002_third', statement: 2, statements: 2 });
    expect((error as Error).message).toBe('Tenant migration 0002_third failed at statement 2 of 2 (SQLSTATE 42P07)');
    expect((error as Error).message).not.toContain('secret');
    expect(executed.some((e) => e.text.startsWith('INSERT INTO "__drizzle_migrations"'))).toBe(false);
  });
});

describe('bundledJournalEntries', () => {
  it('lists every bundled migration with its when and hash', () => {
    expect(bundledJournalEntries()).toEqual([
      { tag: '0000_first', when: 100, hash: 'h0' },
      { tag: '0001_second', when: 200, hash: 'h1' },
      { tag: '0002_third', when: 150, hash: 'h2' },
    ]);
  });
});
