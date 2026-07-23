/**
 * Per-request master-DB Drizzle client over Hyperdrive.
 *
 * Master holds the cross-workspace WeldApps tables (user_apps, installs,
 * tokens, oauth clients) — same connection style as the auth middleware.
 */

import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as masterSchema from '@weldsuite/db/schema/master';

export { masterSchema };

export type MasterDatabase = PostgresJsDatabase<typeof masterSchema>;

export function createMasterDb(hyperdrive: Hyperdrive): MasterDatabase {
  const sql = postgres(hyperdrive.connectionString, { max: 1, prepare: false });
  return drizzle(sql, { schema: masterSchema });
}
