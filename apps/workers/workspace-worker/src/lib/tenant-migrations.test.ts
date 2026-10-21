import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlStatement, TenantSql } from './database-move/types';

const bundle = vi.hoisted(() => {
  const sql: Record<string, string> = {
    '0000_first': 'CREATE TABLE a (id int);',
    '0001_second': 'CREATE TABLE b (id int);',
    '0002_third': 'CREATE TABLE c (id int);--> statement-breakpoint\nCREATE INDEX c_id ON c (id);',
  };
  return {
    MIGRATION_JOURNAL: [
      { idx: 0, tag: '0000_first', when: 100 },
      { idx: 1, tag: '0001_second', when: 200 },
      { idx: 2, tag: '0002_third', when: 150 }, // merged with an older timestamp
    ],
    MIGRATION_SQL: sql,
    MIGRATION_HASHES: { '0000_first': 'h0', '0001_second': 'h1', '0002_third': 'h2' } as Record<string, string>,
    original: { ...sql },
  };
});
vi.mock('../generated/tenant-migrations', () => bundle);

import {
  applyTenantMigrations,
  bundledJournalEntries,
  findNonTransactionalStatement,
  splitMigration,
  TenantMigrationError,
} from './tenant-migrations';

type Row = { tag: string | null; hash: string | null; created_at: string | null };

const JOURNAL_READ = 'SELECT tag, hash, created_at::text AS created_at FROM "__drizzle_migrations"';
const RECORD = 'INSERT INTO "__drizzle_migrations" (hash, created_at, tag) VALUES ($1, $2, $3)';

/** A database whose journal holds `rows`. Records every transaction, and fails the ones `fail` picks. */
function fakeSql(rows: Row[], fail?: (statements: readonly SqlStatement[]) => unknown) {
  const transactions: SqlStatement[][] = [];
  const sql: TenantSql = {
    query() {
      return Promise.reject(new Error('the applier only sends transactions'));
    },
    async transaction(statements) {
      transactions.push([...statements]);
      const error = fail?.(statements);
      if (error) throw error;
      return statements.map((statement) => (statement.text === JOURNAL_READ ? rows : []));
    },
  };
  return { sql, transactions };
}

const texts = (statements: readonly SqlStatement[]) => statements.map((statement) => statement.text);

describe('applyTenantMigrations', () => {
  afterEach(() => {
    Object.assign(bundle.MIGRATION_SQL, bundle.original);
  });

  it('creates the journal table, adds the tag column a drizzle-made one lacks, and reads it, in one request', async () => {
    const { sql, transactions } = fakeSql([]);
    await applyTenantMigrations(sql);
    const [setup = []] = transactions;
    expect(setup).toHaveLength(3);
    expect(setup[0]?.text).toMatch(/^CREATE TABLE IF NOT EXISTS "__drizzle_migrations"/);
    expect(setup[1]?.text).toBe('ALTER TABLE "__drizzle_migrations" ADD COLUMN IF NOT EXISTS tag text');
    expect(setup[2]?.text).toBe(JOURNAL_READ);
  });

  it('applies nothing to a database drizzle already migrated (rows with a hash or created_at, no tag)', async () => {
    const { sql, transactions } = fakeSql([
      { tag: null, hash: 'h0', created_at: '100' },
      { tag: null, hash: 'edited-since', created_at: '200' },
      { tag: null, hash: 'h2', created_at: '150' },
    ]);
    expect(await applyTenantMigrations(sql)).toEqual({ applied: 0, skipped: 3, remaining: 0 });
    expect(transactions).toHaveLength(1);
  });

  it('applies the migration drizzle skipped in one transaction that also records it, with its tag', async () => {
    const { sql, transactions } = fakeSql([
      { tag: null, hash: 'h0', created_at: '100' },
      { tag: '0001_second', hash: 'h1', created_at: '200' },
    ]);
    expect(await applyTenantMigrations(sql)).toEqual({ applied: 1, skipped: 2, remaining: 0 });
    expect(transactions).toHaveLength(2);
    expect(transactions[1]).toEqual([
      { text: 'CREATE TABLE c (id int);' },
      { text: 'CREATE INDEX c_id ON c (id);' },
      { text: RECORD, params: ['h2', 150, '0002_third'] },
    ]);
  });

  it('gives every pending migration its own transaction, in journal order', async () => {
    const { sql, transactions } = fakeSql([]);
    expect(await applyTenantMigrations(sql)).toEqual({ applied: 3, skipped: 0, remaining: 0 });
    expect(transactions.slice(1).map(texts)).toEqual([
      ['CREATE TABLE a (id int);', RECORD],
      ['CREATE TABLE b (id int);', RECORD],
      ['CREATE TABLE c (id int);', 'CREATE INDEX c_id ON c (id);', RECORD],
    ]);
  });

  it('stops at the statement budget, but always applies at least one migration', async () => {
    expect(await applyTenantMigrations(fakeSql([]).sql, { statementBudget: 1 })).toEqual({
      applied: 1,
      skipped: 0,
      remaining: 2,
    });
    // 0000 and its record are 2 statements, 0001 another 2: the budget of 3 is spent after 0001.
    expect(await applyTenantMigrations(fakeSql([]).sql, { statementBudget: 3 })).toEqual({
      applied: 2,
      skipped: 0,
      remaining: 1,
    });
  });

  it('names the migration that failed, with the SQLSTATE only, and keeps the ones before it', async () => {
    const driverError = Object.assign(new Error('relation "c_id" already exists, value=secret'), { code: '42P07' });
    const { sql, transactions } = fakeSql([], (statements) =>
      texts(statements).includes('CREATE INDEX c_id ON c (id);') ? driverError : undefined,
    );
    const error = await applyTenantMigrations(sql).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantMigrationError);
    expect(error).toMatchObject({ tag: '0002_third', statements: 2, statement: null, sqlState: '42P07' });
    expect((error as Error).message).toBe('Tenant migration 0002_third failed (2 statements in one transaction, SQLSTATE 42P07)');
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).cause).toBe(driverError);
    // 0000 and 0001 went in transactions of their own before it.
    expect(transactions).toHaveLength(4);
  });

  it('finds the SQLSTATE under a wrapping error', async () => {
    const wrapped = new Error('Failed query: CREATE TABLE c', { cause: Object.assign(new Error('x'), { code: '42501' }) });
    const { sql } = fakeSql([], (statements) => (statements[0]?.text === 'CREATE TABLE a (id int);' ? wrapped : undefined));
    await expect(applyTenantMigrations(sql)).rejects.toMatchObject({ tag: '0000_first', sqlState: '42501' });
  });

  it('has no SQLSTATE when the request got no answer', async () => {
    const { sql } = fakeSql([{ tag: '0000_first', hash: 'h0', created_at: '100' }], (statements) =>
      statements.length > 1 && statements[0]?.text.startsWith('CREATE TABLE b') ? new TypeError('fetch failed') : undefined,
    );
    const error = await applyTenantMigrations(sql).catch((e: unknown) => e);
    expect(error).toMatchObject({ tag: '0001_second', sqlState: null, statement: null });
    expect((error as Error).message).toBe('Tenant migration 0001_second failed (1 statement in one transaction)');
  });

  it('refuses a migration that cannot run inside a transaction before any of it runs', async () => {
    bundle.MIGRATION_SQL['0002_third'] = 'CREATE TABLE c (id int);--> statement-breakpoint\nCREATE INDEX CONCURRENTLY c_id ON c (id);';
    const { sql, transactions } = fakeSql([
      { tag: '0000_first', hash: 'h0', created_at: '100' },
      { tag: '0001_second', hash: 'h1', created_at: '200' },
    ]);
    const error = await applyTenantMigrations(sql).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantMigrationError);
    expect(error).toMatchObject({ tag: '0002_third', statement: 2, statements: 2, sqlState: null });
    expect((error as Error).message).toBe(
      'Tenant migration 0002_third cannot run inside a transaction: statement 2 of 2 is a CONCURRENTLY operation. ' +
      'Nothing was applied',
    );
    expect(transactions).toHaveLength(1); // only the journal read
  });
});

describe('findNonTransactionalStatement', () => {
  it.each([
    ['CREATE INDEX CONCURRENTLY "x_idx" ON "x" ("a")', 'a CONCURRENTLY operation'],
    ['CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON x (a)', 'a CONCURRENTLY operation'],
    ['drop index concurrently x_idx', 'a CONCURRENTLY operation'],
    ['REINDEX INDEX CONCURRENTLY x_idx', 'a CONCURRENTLY operation'],
    ['ALTER TABLE p DETACH PARTITION p_1 CONCURRENTLY', 'a CONCURRENTLY operation'],
    ['REINDEX SCHEMA public', 'REINDEX of a schema, database or system'],
    ['VACUUM ANALYZE x', 'VACUUM'],
    ['CREATE DATABASE other', 'CREATE/DROP DATABASE or TABLESPACE'],
    [`ALTER SYSTEM SET work_mem = '64MB'`, 'ALTER SYSTEM'],
    ['COMMIT', 'transaction control'],
    ['-- start over\nBEGIN', 'transaction control'],
  ])('refuses %j', (statement, reason) => {
    expect(findNonTransactionalStatement(['CREATE TABLE x (a int)', statement])).toEqual({ statement: 2, reason });
  });

  it.each([
    // Runs in a transaction since PostgreSQL 12.
    [`ALTER TYPE "public"."mail_provider" ADD VALUE 'resend' BEFORE 'custom'`],
    [`ALTER TYPE "public"."status" ADD VALUE IF NOT EXISTS 'failed'`],
    // Only a comment mentions it (0175 has one like this).
    ['-- Note CONCURRENTLY is deliberately NOT used.\nCREATE INDEX "x_idx" ON "x" USING hnsw ("e" vector_cosine_ops)'],
    ['/* not CONCURRENTLY */ CREATE INDEX x_idx ON x (a)'],
    [`COMMENT ON TABLE x IS 'rebuilt concurrently, it''s fine'`],
    [`DO $$ BEGIN CREATE TYPE s AS ENUM ('a'); EXCEPTION WHEN duplicate_object THEN null; END $$`],
    ['CREATE FUNCTION f() RETURNS void AS $body$ BEGIN COMMIT; END $body$ LANGUAGE plpgsql'],
    ['REFRESH MATERIALIZED VIEW CONCURRENTLY v'],
    ['REINDEX TABLE x'],
  ])('lets %j run in the transaction', (statement) => {
    expect(findNonTransactionalStatement([statement])).toBeNull();
  });
});

describe('the tenant journal', () => {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../packages/core/db/drizzle/tenant-migrations',
  );
  const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };

  it('holds no migration that cannot be applied atomically', () => {
    const refused = journal.entries.flatMap(({ tag }) => {
      const hit = findNonTransactionalStatement(splitMigration(readFileSync(path.join(dir, `${tag}.sql`), 'utf8')));
      return hit ? [{ tag, ...hit }] : [];
    });
    expect(refused).toEqual([]);
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
