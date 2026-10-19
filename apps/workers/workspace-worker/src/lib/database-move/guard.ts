/**
 * Source-side guards. These are the database half of "lock the source": the
 * Workflow rotates the role password through the Neon API first (so nothing can
 * reconnect), then calls these to make the database read-only for new sessions
 * and to kill the sessions that were already open.
 *
 * Why the order matters: `default_transaction_read_only` only applies to NEW
 * sessions, and a session that sets `SET default_transaction_read_only = off`
 * itself can still write. The password rotation is what stops reconnects; the
 * read-only default is a second fence; terminating sessions evicts whatever was
 * connected before the fences went up.
 */

import { GuardError } from './errors';
import { quoteIdent } from './quote';
import { readBool, readInt, readString } from './rows';
import type { TenantSql } from './types';

const READ_ONLY_SETTING = 'default_transaction_read_only';

/** Name of the database the connection is on. Pass it to the lock/unlock functions. */
export async function currentDatabaseName(sql: TenantSql): Promise<string> {
  const [row] = await sql.query('SELECT current_database() AS name');
  if (!row) throw new GuardError('current_database() returned nothing');
  return readString(row, 'name');
}

/** Make the database read-only by default for every NEW session. Idempotent. */
export async function lockDatabase(sql: TenantSql, dbName: string): Promise<void> {
  await sql.query(`ALTER DATABASE ${quoteIdent(dbName)} SET ${READ_ONLY_SETTING} = on`);
}

/**
 * Undo `lockDatabase`. The ALTER has to run in a transaction that starts with
 * `SET TRANSACTION READ WRITE`: on a locked database every new transaction is
 * read-only, and a plain `ALTER DATABASE ... RESET` fails with 25006.
 */
export async function unlockDatabase(sql: TenantSql, dbName: string): Promise<void> {
  await sql.transaction([
    { text: 'SET TRANSACTION READ WRITE' },
    { text: `ALTER DATABASE ${quoteIdent(dbName)} RESET ${READ_ONLY_SETTING}` },
  ]);
}

/** `transaction_read_only` as seen by a fresh transaction on this connection: `'on'` when the lock is in effect. */
export async function probeReadOnly(sql: TenantSql): Promise<'on' | 'off'> {
  const [row] = await sql.query(`SELECT current_setting('transaction_read_only') AS value`);
  if (!row) throw new GuardError('transaction_read_only probe returned nothing');
  const value = readString(row, 'value');
  if (value === 'on' || value === 'off') return value;
  throw new GuardError(`Unexpected transaction_read_only value "${value}"`);
}

export interface TerminateResult {
  /** Other client sessions found on the database. */
  found: number;
  /** `pg_terminate_backend` returned true for this many. */
  terminated: number;
  /** Sessions it could not signal (insufficient privilege, already gone). */
  failed: number;
}

/**
 * Terminate every other client session on the current database (`pid <>
 * pg_backend_pid()`). Background workers (autovacuum, replication) are left
 * alone. Returns counts only; session details can carry query text and are
 * never read.
 */
export async function terminateOtherSessions(sql: TenantSql): Promise<TerminateResult> {
  const rows = await sql.query(
    `SELECT pg_terminate_backend(pid) AS terminated
     FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
  );
  const terminated = rows.filter((row) => readBool(row, 'terminated')).length;
  return { found: rows.length, terminated, failed: rows.length - terminated };
}

/** How many other client sessions are still connected (the drain check after `terminateOtherSessions`). */
export async function countOtherSessions(sql: TenantSql): Promise<number> {
  const [row] = await sql.query(
    `SELECT count(*)::text AS count
     FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
  );
  return row ? readInt(row, 'count') : 0;
}
