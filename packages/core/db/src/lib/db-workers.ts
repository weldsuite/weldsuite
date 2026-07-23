import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as masterSchema from '../schema/master';

/**
 * Hyperdrive binding type from Cloudflare Workers
 */
interface Hyperdrive {
  connectionString: string;
}

/**
 * Postgres-js options optimized for Hyperdrive
 * These settings are required for proper operation with Cloudflare Hyperdrive
 */
const HYPERDRIVE_OPTIONS = {
  max: 1, // Workers limit concurrent connections
  prepare: false, // Disable prepare since Hyperdrive doesn't support it
};

/**
 * Create a master database client from Hyperdrive binding
 * Use this for workspace routing and cross-tenant operations
 *
 * @param hyperdrive - Hyperdrive binding from Cloudflare Workers env
 * @returns Drizzle ORM database instance with master schema
 */
export function createMasterDbFromHyperdrive(
  hyperdrive: Hyperdrive
): PostgresJsDatabase<typeof masterSchema> {
  const sql = postgres(hyperdrive.connectionString, HYPERDRIVE_OPTIONS);
  return drizzle(sql, { schema: masterSchema });
}

// Re-export types
export type MasterDb = PostgresJsDatabase<typeof masterSchema>;
