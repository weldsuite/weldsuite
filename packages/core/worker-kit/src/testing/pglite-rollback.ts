/**
 * The TypeScript side of a conforming write, run on the test's own pglite
 * inside a transaction that is rolled back afterwards, so the Rust side then
 * starts from the state TypeScript started from (./conformance.ts).
 *
 * It used to run on a copy (`PGlite.clone()`), one new pglite instance per
 * write, closed once the write was done. Creating and closing pglite
 * instances while another one keeps working corrupts the process's memory
 * (pglite 0.4.5 on Node 22, Windows and Linux alike): after tens to a few
 * hundred copies of the tenant database, a segfault or access violation, a
 * V8 fatal error (`Check failed: maybe_code.has_value()`, `unreachable
 * code` in TurboFan), an `ErrnoError` (errno 44 or 20) out of pglite's file
 * system, a spurious WebAssembly validation error, or an endless loop. A
 * loop of `clone()` and `close()` with a few queries on the original in
 * between does it on its own, without vitest, Rust or the socket server;
 * the same loop with the original left idle, or dumping the original
 * without creating instances, does not. V8 flags (no wasm code GC, liftoff
 * only, no trap handler, no native module cache, forced or single-threaded
 * GC) do not help. So the harness creates no instance per write any more.
 *
 * Each statement the TypeScript side runs outside a transaction of its own
 * gets a savepoint, released when it succeeds and rolled back when it fails,
 * as autocommit would; a transaction of its own (`db.transaction()`) is a
 * savepoint as a whole, with drizzle's nested savepoints inside it. The one
 * difference from autocommit: `now()` (a column's `defaultNow()`) is the
 * same for every statement of one write, the transaction's start.
 *
 * While the TypeScript side holds a database, the socket server the Rust
 * side connects through waits ({@link heldByTypeScript}), and a Rust
 * connection that closes meanwhile does not roll the transaction back.
 */

import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Database } from '../env';

type Query = PGlite['query'];

/** The databases the TypeScript side holds now, and when it lets go. */
const held = new WeakMap<object, Promise<void>>();

/** When the TypeScript side lets go of `client`, if it holds it now. */
export function heldByTypeScript(client: object): Promise<void> | undefined {
  return held.get(client);
}

const OVER = 'The TypeScript side of this write is over: its database is no longer open';

/**
 * A drizzle handle on `client` for the TypeScript side of one write, in a
 * transaction; `close()` rolls it back.
 */
export async function typeScriptSide(
  client: PGlite,
  kind: 'tenant' | 'master',
): Promise<{ db: Database; close: () => Promise<void> }> {
  const [drizzlePg, schema] = await Promise.all([
    import('drizzle-orm/pglite'),
    kind === 'master' ? import('@weldsuite/db/schema/master') : import('@weldsuite/db/schema'),
  ]);
  if (client.isInTransaction()) {
    throw new Error('Conformance: the test database has a transaction open before a write; the last request left it so.');
  }
  let letGo = (): void => undefined;
  held.set(client, new Promise<void>((resolve) => (letGo = resolve)));
  try {
    await client.query('begin');
  } catch (error) {
    held.delete(client);
    letGo();
    throw error;
  }

  let open = true;
  let savepoints = 0;
  // One statement (or transaction) at a time, as pglite runs them anyway.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
  const ensureOpen = () => {
    if (!open) throw new Error(OVER);
  };
  /** `work` as autocommit would run it: all of it or none of it. */
  const atomic = <T>(work: () => Promise<T>): Promise<T> =>
    serial(async () => {
      ensureOpen();
      const name = `weld_conformance_${++savepoints}`;
      await client.query(`savepoint ${name}`);
      try {
        const result = await work();
        await client.query(`release savepoint ${name}`);
        return result;
      } catch (error) {
        await client.query(`rollback to savepoint ${name}`);
        await client.query(`release savepoint ${name}`);
        throw error;
      }
    });

  // A transaction of the TypeScript side's own: its statements run as they
  // come, and one that fails leaves it aborted, as in Postgres.
  const inTransaction: Pick<Transaction, 'query' | 'sql' | 'exec' | 'rollback' | 'closed'> = {
    query: ((...args: Parameters<Query>) => {
      ensureOpen();
      return client.query(...args);
    }) as Query,
    sql: ((...args: Parameters<PGlite['sql']>) => {
      ensureOpen();
      return client.sql(...args);
    }) as PGlite['sql'],
    exec: (...args: Parameters<PGlite['exec']>) => {
      ensureOpen();
      return client.exec(...args);
    },
    rollback: () => Promise.reject(new Error('rollback')),
    closed: false,
  };

  const side = new Proxy(client, {
    get(target, property) {
      if (property === 'query') {
        return ((...args: Parameters<Query>) => atomic(() => client.query(...args))) as Query;
      }
      if (property === 'sql') {
        return (...args: Parameters<PGlite['sql']>) => atomic(() => client.sql(...args));
      }
      if (property === 'exec') {
        return (...args: Parameters<PGlite['exec']>) => atomic(() => client.exec(...args));
      }
      if (property === 'transaction') {
        return <T>(callback: (tx: Transaction) => Promise<T>) =>
          atomic(() => callback(inTransaction as unknown as Transaction));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  const db = drizzlePg.drizzle(side as never, { schema }) as unknown as Database;
  return {
    db,
    close: async () => {
      // After whatever is still queued, so nothing lands outside the transaction.
      await serial(async () => {
        open = false;
      });
      try {
        await client.query('rollback');
      } finally {
        held.delete(client);
        letGo();
      }
    },
  };
}
