/**
 * Test databases in pglite: an in-process PostgreSQL (WASM,
 * `@electric-sql/pglite`) behind Drizzle's pglite adapter, built from the
 * journaled migrations in `rust/migrations` (ADR DATA-019), the same ones
 * `weldsuite migrate` runs. For the service and room tests of the TypeScript
 * packages that stay (the collab rooms, WeldSheets' data sources, WeldDrive).
 *
 *   const { db } = await createPgliteDb();
 *
 * The first call takes a few seconds (the WASM and every migration); later
 * calls in the same Vitest worker reuse the database. Tests that need it can
 * check `isPgliteAvailable()` first and skip where pglite can't start.
 */

import type { TenantDb } from '../lib/any-db';

interface PgliteHandle<Db> {
  db: Db;
  close: () => Promise<void>;
}

/** `rust/migrations/<folder>`, from this file (src/testing). */
async function migrationsDir(folder: 'tenant' | 'master'): Promise<string> {
  const [path, url] = await Promise.all([import('node:path'), import('node:url')]);
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../../rust/migrations', folder);
}

/**
 * Applies exactly what the migration runner applies: the journal's entries,
 * in journal order. The history isn't idempotent on a fresh database (a later
 * migration sometimes re-adds what an earlier one created), so "already
 * exists" and "does not exist" are tolerated; anything else fails the test.
 */
async function applyMigrations(client: { exec(sql: string): Promise<unknown> }, folder: 'tenant' | 'master'): Promise<void> {
  const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
  const dir = await migrationsDir(folder);
  const journal = JSON.parse(await fs.readFile(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const files = [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => `${entry.tag}.sql`);
  for (const file of files) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    const statements = raw
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        await client.exec(stmt);
      } catch (err) {
        const msg = (err as Error).message;
        if (/already exists/i.test(msg) || /does not exist/i.test(msg)) continue;
        throw new Error(`pglite failed on ${folder} migration ${file}: ${msg}\nStatement: ${stmt.slice(0, 200)}…`);
      }
    }
  }
}

let cachedTenant: PgliteHandle<TenantDb> | null = null;
let cachedTenantError: Error | null = null;

/** A tenant database with every tenant migration applied. */
export async function createPgliteDb(): Promise<PgliteHandle<TenantDb>> {
  if (cachedTenant) return cachedTenant;
  if (cachedTenantError) throw cachedTenantError;
  try {
    const [{ PGlite }, { vector }, { pg_trgm }, drizzlePg, schema] = await Promise.all([
      import('@electric-sql/pglite'),
      // pgvector and pg_trgm are separate extension bundles in pglite; the
      // tenant migrations need both (embeddings, the CRM list search).
      import('@electric-sql/pglite/vector'),
      import('@electric-sql/pglite/contrib/pg_trgm'),
      import('drizzle-orm/pglite'),
      import('../schema'),
    ]);
    const client = new PGlite({ extensions: { vector, pg_trgm } });
    const db = drizzlePg.drizzle(client, { schema });
    await applyMigrations(client, 'tenant');
    cachedTenant = {
      db: db as unknown as TenantDb,
      close: async () => {
        await client.close();
        cachedTenant = null;
      },
    };
    return cachedTenant;
  } catch (err) {
    cachedTenantError = err instanceof Error ? err : new Error(String(err));
    throw cachedTenantError;
  }
}

/** Whether pglite can start here; tests that need it skip when it can't. */
export async function isPgliteAvailable(): Promise<boolean> {
  try {
    await createPgliteDb();
    return true;
  } catch {
    return false;
  }
}
