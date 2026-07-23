/**
 * pglite-backed test database helper.
 *
 * Builds an in-process PostgreSQL via WASM (`@electric-sql/pglite`), wraps it
 * with Drizzle's pglite adapter, and applies the WeldSuite tenant migrations so
 * engine + action tests can run against a REAL DB.
 *
 * Copied from apps/workers/app-api/src/test/pglite.ts — keep them in sync.
 *
 *   const { db, close } = await createPgliteDb();
 *   try { ...test work... } finally { await close(); }
 *
 * Notes:
 *   - First call is slow (~3-5s): pglite WASM boot + full tenant migration set.
 *     Subsequent calls in the same Vitest worker are cached.
 *   - Tests that need pglite check `isPgliteAvailable()` first so they can skip
 *     gracefully on unsupported platforms.
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
    // @weldsuite/db package — the same ones migrate-databases runs on Neon.
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
      const statements = raw
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        try {
          await client.exec(stmt);
        } catch (err) {
          const msg = (err as Error).message;
          if (/already exists/i.test(msg) || /does not exist/i.test(msg)) {
            continue;
          }
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

export async function isPgliteAvailable(): Promise<boolean> {
  try {
    await createPgliteDb();
    return true;
  } catch {
    return false;
  }
}
