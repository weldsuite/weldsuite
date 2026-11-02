/**
 * pglite-backed test database helper: worker-kit's, so a test's database is
 * one the conformance harness can serve to the Rust server
 * (`pgliteClientOf`). One in-process PostgreSQL (WASM) with every journaled
 * tenant migration applied, cached for the whole run (the vitest config shares
 * one module registry across files).
 *
 *   const { db } = await createPgliteDb();
 */

import type { Database } from '../db';
import {
  createPgliteDb as createKitPgliteDb,
  isPgliteAvailable,
} from '@weldsuite/worker-kit/testing/pglite';

interface PgliteHandle {
  db: Database;
  close: () => Promise<void>;
}

export async function createPgliteDb(): Promise<PgliteHandle> {
  const handle = await createKitPgliteDb();
  return { db: handle.db as unknown as Database, close: handle.close };
}

export { isPgliteAvailable };
