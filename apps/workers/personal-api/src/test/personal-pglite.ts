/**
 * An in-process Postgres (pglite) with the shared personal DB's migrations
 * applied, for route tests that need the real personal schema. Same approach
 * as `@weldsuite/worker-kit/testing/pglite` (which only covers the tenant DB):
 * the journaled SQL files, in journal order, split on Drizzle's breakpoints.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as personalSchema from '@weldsuite/db/schema/personal';
import type { PersonalDatabase } from '../db';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  // src/test → packages/core/db
  '../../../../../packages/core/db/drizzle/personal-migrations',
);

export async function createPersonalPgliteDb(): Promise<{ db: PersonalDatabase; close: () => Promise<void> }> {
  const client = new PGlite();
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      await client.exec(stmt);
    }
  }
  // The routes only use the query builder, which the pglite driver shares with neon-http.
  const db = drizzle(client, { schema: personalSchema }) as unknown as PersonalDatabase;
  return { db, close: () => client.close() };
}
