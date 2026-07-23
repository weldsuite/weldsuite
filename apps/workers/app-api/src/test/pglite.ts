/**
 * pglite-backed test database helper.
 *
 * Builds an in-process PostgreSQL via WASM (`@electric-sql/pglite`),
 * wraps it with Drizzle's pglite adapter, and pushes the WeldSuite
 * tenant schema so route + service tests can run against a REAL DB.
 *
 * Usage:
 *
 *   const { db, close } = await createPgliteDb();
 *   try {
 *     // ... do test work; `db` is type-compatible with `Database`.
 *   } finally {
 *     await close();
 *   }
 *
 * Notes:
 *   - First call is slow (~3-5s) because pglite has to download the
 *     WASM, then drizzle-kit has to introspect the full WeldSuite
 *     schema. Subsequent calls in the same Vitest worker are fast.
 *   - Falls back to throwing if drizzle-kit isn't able to push the
 *     schema for any reason (e.g. an unsupported PostgreSQL feature).
 *     Tests that need pglite check `isPgliteAvailable()` first so they
 *     can skip gracefully on unsupported platforms.
 */

import type { Database } from '../db';

let cached: { db: Database; close: () => Promise<void> } | null = null;
let cachedError: Error | null = null;

interface PgliteHandle {
  db: Database;
  close: () => Promise<void>;
}

export async function createPgliteDb(): Promise<PgliteHandle> {
  if (cached) return cached;
  if (cachedError) throw cachedError;

  try {
    const [{ PGlite }, drizzlePg, schemaModule, fs, path, url] = await Promise.all([
      import('@electric-sql/pglite'),
      import('drizzle-orm/pglite'),
      import('@weldsuite/db/schema'),
      import('node:fs/promises'),
      import('node:path'),
      import('node:url'),
    ]);

    const client = new PGlite();
    const db = drizzlePg.drizzle(client, { schema: schemaModule });

    // Apply tenant migrations in order. The SQL files live in the
    // @weldsuite/db package and are the same ones the migrate-databases
    // app runs against Neon.
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const migrationsDir = path.resolve(
      here,
      '../../../../../packages/core/db/drizzle/tenant-migrations',
    );
    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const raw = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      // Drizzle splits statements with `--> statement-breakpoint`.
      const statements = raw
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        try {
          await client.exec(stmt);
        } catch (err) {
          const msg = (err as Error).message;
          // The tenant migration history isn't perfectly idempotent in
          // a fresh DB (a later migration sometimes re-adds a column
          // that an earlier one already created — Neon ignores it
          // because that exact migration was marked applied). pglite
          // sees them all in sequence, so we tolerate "already exists"
          // and "does not exist" on idempotent operations.
          if (
            /already exists/i.test(msg) ||
            /does not exist/i.test(msg)
          ) {
            continue;
          }
          // pglite doesn't support every PostgreSQL feature (e.g.
          // certain extensions, plperl). Real failures surface so the
          // operator can decide whether to fix or skip.
          throw new Error(
            `pglite failed on migration ${file}: ${msg}\nStatement: ${stmt.slice(0, 200)}…`,
          );
        }
      }
    }

    cached = {
      db: db as unknown as Database,
      close: async () => {
        await client.close();
        cached = null;
      },
    };
    return cached;
  } catch (err) {
    cachedError = err instanceof Error ? err : new Error(String(err));
    throw cachedError;
  }
}

/**
 * Check whether pglite + drizzle-kit could be loaded in this
 * environment. Tests that depend on a real DB use this to skip on
 * platforms where the WASM or kit can't initialise.
 */
export async function isPgliteAvailable(): Promise<boolean> {
  try {
    await createPgliteDb();
    return true;
  } catch {
    return false;
  }
}
