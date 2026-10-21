/**
 * PGlite as a `TenantSql`, for tests of the database-move engine.
 *
 * Deliberately NOT cached (unlike worker-kit's `createPgliteDb`): the move
 * engine needs two independent databases per test, a source and a target.
 * Each call builds a fresh in-process Postgres (~0.7 s) with the `vector`
 * extension registered, as the worker-kit harness does.
 *
 * pglite crashes when many instances start at the same time (see the note on
 * the unit-public-api job in .github/workflows/ci.yml), so tests using this
 * helper create their databases one after the other, in a single file.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { SqlRow, TenantSql } from '../lib/database-move/types';

export interface PgliteTenant {
  db: PGlite;
  sql: TenantSql;
  /** Run one or more statements without parameters (DDL, seed data). */
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

export function pgliteTenantSql(db: PGlite): TenantSql {
  return {
    async query(text, params) {
      const result = await db.query<SqlRow>(text, params ? [...params] : []);
      return result.rows;
    },
    async transaction(statements) {
      return db.transaction(async (tx) => {
        const results: SqlRow[][] = [];
        for (const statement of statements) {
          const result = await tx.query<SqlRow>(statement.text, statement.params ? [...statement.params] : []);
          results.push(result.rows);
        }
        return results;
      });
    },
  };
}

export async function createPgliteTenant(): Promise<PgliteTenant> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  return {
    db,
    sql: pgliteTenantSql(db),
    async exec(text) {
      await db.exec(text);
    },
    close: () => db.close(),
  };
}
