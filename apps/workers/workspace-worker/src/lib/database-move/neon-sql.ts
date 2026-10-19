/**
 * `TenantSql` over the Neon serverless HTTP driver, the way this worker talks
 * to tenant databases everywhere else. Every `query` is one subrequest; every
 * `transaction` is ONE subrequest however many statements it carries.
 *
 * The connection string is only handed to `neon()`; it is never logged or put
 * in an error message here.
 */

import { neon } from '@neondatabase/serverless';
import type { SqlRow, TenantSql } from './types';

export function neonTenantSql(connectionString: string): TenantSql {
  const sql = neon(connectionString);
  return {
    async query(text, params) {
      const rows: SqlRow[] = await sql.query(text, params ? [...params] : []);
      return rows;
    },
    async transaction(statements) {
      const results: SqlRow[][] = await sql.transaction(
        statements.map((statement) => sql.query(statement.text, statement.params ? [...statement.params] : [])),
      );
      return results;
    },
  };
}
