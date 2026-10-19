/**
 * Guard functions against a fake `TenantSql` that records the SQL it is given:
 * PGlite cannot do `ALTER DATABASE` or terminate other sessions in any
 * meaningful way, so what matters here is the exact statements and how the
 * results are read.
 */

import { describe, expect, it } from 'vitest';
import { GuardError } from './errors';
import {
  countOtherSessions,
  currentDatabaseName,
  lockDatabase,
  probeReadOnly,
  terminateOtherSessions,
  unlockDatabase,
} from './guard';
import type { SqlRow, SqlStatement, TenantSql } from './types';

interface Recorded {
  queries: Array<{ text: string; params: readonly unknown[] | undefined }>;
  transactions: SqlStatement[][];
}

function fakeSql(respond: (text: string) => SqlRow[] = () => []): { sql: TenantSql; recorded: Recorded } {
  const recorded: Recorded = { queries: [], transactions: [] };
  const sql: TenantSql = {
    async query(text, params) {
      recorded.queries.push({ text, params });
      return respond(text);
    },
    async transaction(statements) {
      recorded.transactions.push([...statements]);
      return statements.map((s) => respond(s.text));
    },
  };
  return { sql, recorded };
}

describe('lockDatabase', () => {
  it('sets default_transaction_read_only on the database, as a plain statement', async () => {
    const { sql, recorded } = fakeSql();
    await lockDatabase(sql, 'tenant_db');
    expect(recorded.queries.map((q) => q.text)).toEqual([`ALTER DATABASE "tenant_db" SET default_transaction_read_only = on`]);
    expect(recorded.transactions).toEqual([]);
  });

  it('quotes the identifier, doubling embedded quotes', async () => {
    const { sql, recorded } = fakeSql();
    await lockDatabase(sql, 'we"ird; DROP DATABASE x; --');
    expect(recorded.queries[0]?.text).toBe(
      `ALTER DATABASE "we""ird; DROP DATABASE x; --" SET default_transaction_read_only = on`,
    );
  });
});

describe('unlockDatabase', () => {
  it('runs one transaction that starts with SET TRANSACTION READ WRITE, then RESETs the setting', async () => {
    const { sql, recorded } = fakeSql();
    await unlockDatabase(sql, 'tenant_db');
    expect(recorded.queries).toEqual([]);
    expect(recorded.transactions).toEqual([
      [{ text: 'SET TRANSACTION READ WRITE' }, { text: `ALTER DATABASE "tenant_db" RESET default_transaction_read_only` }],
    ]);
  });
});

describe('probeReadOnly', () => {
  it('returns the transaction_read_only setting', async () => {
    const on = fakeSql(() => [{ value: 'on' }]);
    expect(await probeReadOnly(on.sql)).toBe('on');
    expect(on.recorded.queries[0]?.text).toContain(`current_setting('transaction_read_only')`);
    expect(await probeReadOnly(fakeSql(() => [{ value: 'off' }]).sql)).toBe('off');
  });

  it('refuses anything else', async () => {
    await expect(probeReadOnly(fakeSql(() => [{ value: 'maybe' }]).sql)).rejects.toBeInstanceOf(GuardError);
    await expect(probeReadOnly(fakeSql(() => []).sql)).rejects.toBeInstanceOf(GuardError);
  });
});

describe('terminateOtherSessions', () => {
  it('targets this database only, never its own backend, and only client sessions', async () => {
    const { sql, recorded } = fakeSql(() => []);
    await terminateOtherSessions(sql);
    const text = recorded.queries[0]?.text ?? '';
    expect(text).toContain('pg_terminate_backend(pid)');
    expect(text).toContain('datname = current_database()');
    expect(text).toContain('pid <> pg_backend_pid()');
    expect(text).toContain(`backend_type = 'client backend'`);
  });

  it('counts what it found, terminated and failed', async () => {
    const { sql } = fakeSql(() => [{ terminated: true }, { terminated: true }, { terminated: false }]);
    expect(await terminateOtherSessions(sql)).toEqual({ found: 3, terminated: 2, failed: 1 });
  });

  it('is happy with no other sessions', async () => {
    expect(await terminateOtherSessions(fakeSql(() => []).sql)).toEqual({ found: 0, terminated: 0, failed: 0 });
  });
});

describe('countOtherSessions and currentDatabaseName', () => {
  it('parses the count (a bigint comes back as text)', async () => {
    expect(await countOtherSessions(fakeSql(() => [{ count: '4' }]).sql)).toBe(4);
    expect(await countOtherSessions(fakeSql(() => [{ count: 0 }]).sql)).toBe(0);
  });

  it('reads current_database()', async () => {
    const { sql, recorded } = fakeSql(() => [{ name: 'neondb' }]);
    expect(await currentDatabaseName(sql)).toBe('neondb');
    expect(recorded.queries[0]?.text).toContain('current_database()');
  });
});
