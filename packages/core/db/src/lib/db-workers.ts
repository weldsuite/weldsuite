import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as masterSchema from '../schema/master';
import * as personalSchema from '../schema/personal';

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
  const sqlClient = postgres(hyperdrive.connectionString, HYPERDRIVE_OPTIONS);
  return drizzle(sqlClient, { schema: masterSchema });
}

/**
 * Create a shared personal database client from Hyperdrive binding.
 * Personal Weld accounts (consumer apps) store mail here, keyed by personalAccountId.
 */
export function createPersonalDbFromHyperdrive(
  hyperdrive: Hyperdrive
): PostgresJsDatabase<typeof personalSchema> {
  const sqlClient = postgres(hyperdrive.connectionString, HYPERDRIVE_OPTIONS);
  return drizzle(sqlClient, { schema: personalSchema });
}

/**
 * Create a shared personal database client from a connection URL (local / Neon).
 */
export function createPersonalDbFromUrl(
  connectionString: string
): PostgresJsDatabase<typeof personalSchema> {
  const sqlClient = postgres(connectionString, HYPERDRIVE_OPTIONS);
  return drizzle(sqlClient, { schema: personalSchema });
}

// Re-export types
export type MasterDb = PostgresJsDatabase<typeof masterSchema>;
export type PersonalDb = PostgresJsDatabase<typeof personalSchema>;
