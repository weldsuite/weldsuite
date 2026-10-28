/**
 * Run several statements as one unit and get each statement's own result
 * back.
 *
 * `@weldsuite/worker-kit/atomically` already covers the two drivers the
 * tenant DB runs on: neon-http's `db.batch()` (several statements, one HTTPS
 * round trip, one transaction) in production, falling back to a real
 * `db.transaction()` on pglite (used by tests, which has no `batch`). That
 * helper discards every statement's result, which is fine for writes that
 * only need to land together. The thread list and the stats endpoint need
 * the *rows* each statement returns (a snooze-wake UPDATE sharing a round
 * trip with the count and page SELECTs, say), so this is the
 * result-returning twin of the same fallback — kept local to mail-domain
 * rather than added to the shared helper, since no other module needed it
 * yet (docs/plans/weldmail-mailbox-storage.md, phase 1 item 3).
 *
 * `build` receives the handle to construct the statements against. On the
 * pglite fallback that handle is the transaction, not the outer `db`, so a
 * statement built from it reads the other statements' writes within the same
 * transaction. Drizzle query builders are lazy, so building a statement never
 * executes it early.
 */
import type { Database } from '@weldsuite/worker-kit/db';

export async function batchQueries(
  db: Database,
  build: (handle: Database) => readonly unknown[],
): Promise<unknown[]> {
  const driver = db as unknown as {
    batch?: (items: unknown[]) => Promise<unknown[]>;
    transaction?: <R>(fn: (tx: Database) => Promise<R>) => Promise<R>;
  };

  if (typeof driver.batch === 'function') {
    return driver.batch(build(db) as unknown[]);
  }
  if (typeof driver.transaction === 'function') {
    return driver.transaction(async (tx) => {
      const results: unknown[] = [];
      for (const statement of build(tx)) results.push(await statement);
      return results;
    });
  }
  const results: unknown[] = [];
  for (const statement of build(db)) results.push(await statement);
  return results;
}

/**
 * Run a batch that leads with a write meant only as a side effect (wake
 * snoozed mail, resolve expired scheduled mail) followed by the reads the
 * caller actually needs, as one round trip. A read must keep working even
 * when the write can't land — most often because the workspace is read-only
 * during a database move (`readOnlyReason: 'database_move'`,
 * `packages/core/worker-kit/src/db.ts`), which fails the write with a
 * Postgres read-only-transaction error and, inside a shared `db.batch`, would
 * otherwise take the whole batch's reads down with it. So on any failure this
 * retries once with `readsOnly` alone (a second round trip, only on the
 * failure path) and logs a short warning — no query text, no row ids beyond
 * what `err` itself carries, matching the warnings already logged around
 * wake elsewhere in this module.
 *
 * `withWrite` must build exactly the write statement followed by
 * `readsOnly`'s statements, in the same order, so the two results line up.
 */
export async function batchWriteThenReads(
  db: Database,
  withWrite: (handle: Database) => readonly [unknown, ...unknown[]],
  readsOnly: (handle: Database) => readonly unknown[],
  warnLabel: string,
): Promise<unknown[]> {
  try {
    const [, ...reads] = await batchQueries(db, withWrite);
    return reads;
  } catch (err) {
    console.warn(`[mail-threads] ${warnLabel} failed, continuing with reads only:`, err);
    return batchQueries(db, readsOnly);
  }
}
