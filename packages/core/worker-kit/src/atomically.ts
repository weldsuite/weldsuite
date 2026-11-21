/**
 * Commit related writes as one unit, whichever driver the tenant DB is on.
 *
 * The tenant DB in production is neon-http, which has no interactive
 * transactions (`db.transaction()` throws "No transactions support"). It does
 * have `db.batch()`, which Neon executes as a single transaction in one HTTP
 * request. Drivers with the support the other way round (pglite, used by tests)
 * fall back to a real transaction, so both paths are atomic.
 *
 * `build` receives the handle to construct against; Drizzle query builders are
 * lazy, so building does not execute. Answers each statement's result, in
 * order (the rows of a `.returning()` statement).
 */
import type { Database } from './env';

export async function atomically(
  db: Database,
  build: (handle: Database) => unknown[],
): Promise<unknown[]> {
  const driver = db as unknown as {
    batch?: (items: unknown[]) => Promise<unknown[]>;
    transaction?: (fn: (tx: Database) => Promise<void>) => Promise<void>;
  };

  if (typeof driver.batch === 'function') {
    return driver.batch(build(db));
  }
  const results: unknown[] = [];
  const run = async (handle: Database) => {
    for (const statement of build(handle)) results.push(await (statement as Promise<unknown>));
  };
  if (typeof driver.transaction === 'function') {
    await driver.transaction(run);
    return results;
  }
  await run(db);
  return results;
}
