import '@tanstack/react-start/server-only';

/**
 * How the console opens a database: Neon's HTTP driver, for the Worker on
 * Global. The Node build for Kubernetes resolves this module to
 * `database.node.ts` (postgres.js over TCP) instead (vite.config.ts).
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { Database, MasterDatabase } from '../db';

/** The master database. A Neon HTTP client holds no connection, so each call makes one. */
export function openMasterDb(url: string): MasterDatabase {
  return drizzle({ client: neon(url), schema: masterSchema });
}

/** A tenant database, by its connection URL. */
export function openTenantDb(url: string): Database {
  return drizzle({ client: neon(url), schema });
}
