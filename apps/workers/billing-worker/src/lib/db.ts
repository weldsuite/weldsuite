/**
 * Database Client for Billing Worker
 *
 * Uses Hyperdrive for the master database connection (via postgres-js).
 * All credit/usage data is now stored in the master database.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { Env } from '../index';

// ============ Master DB (Hyperdrive + postgres-js) ============

function createMasterDb(hyperdrive: Hyperdrive) {
  const sql = postgres(hyperdrive.connectionString, {
    max: 1,
    prepare: false,
  });
  return drizzle(sql, { schema: masterSchema });
}

function createMasterDbFromUrl(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
  });
  return drizzle(sql, { schema: masterSchema });
}

export function getMasterDb(env: Env) {
  if (env.DATABASE_URL_MASTER) {
    return createMasterDbFromUrl(env.DATABASE_URL_MASTER);
  }
  return createMasterDb(env.HYPERDRIVE_MASTER);
}

// Re-export schemas
export { masterSchema };
