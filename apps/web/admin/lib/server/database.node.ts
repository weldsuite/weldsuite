import '@tanstack/react-start/server-only';

/**
 * The Node version of `database.ts`, for the console's container on
 * Kubernetes (ADR FE-018): postgres.js over TCP to CloudNativePG, through its
 * PgBouncer poolers. The Node build (`pnpm build:node`) resolves
 * `@/lib/server/database` to this file (vite.config.ts).
 *
 * - `prepare: false`: a transaction-mode pooler hands each transaction to any
 *   server connection, so named prepared statements would go missing.
 * - One client for the master database, kept for the life of the process.
 * - One client per tenant database URL, at most `ADMIN_TENANT_POOLS` (20) of
 *   them; the least recently used one is closed when another is needed.
 * - On SIGTERM `node/server.mjs` stops taking requests, lets the ones in
 *   flight finish, then closes every client (`closeDatabases`).
 */

import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { Database, MasterDatabase } from '../db';
import type * as Workers from './database';

const OPTIONS = {
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 60,
} as const;

/** Seconds a closing client waits for its queries before it drops them. */
const CLOSE_TIMEOUT = 5;

function tenantPoolLimit(): number {
  const limit = Number.parseInt(process.env.ADMIN_TENANT_POOLS ?? '', 10);
  return Number.isInteger(limit) && limit > 0 ? limit : 20;
}

let master: { url: string; sql: Sql; db: MasterDatabase } | null = null;

/** Tenant clients by URL, least recently used first (a Map keeps insertion order). */
const tenants = new Map<string, { sql: Sql; db: Database }>();

export const openMasterDb: typeof Workers.openMasterDb = (url) => {
  if (master?.url !== url) {
    const sql = postgres(url, { ...OPTIONS, max: 10 });
    master = { url, sql, db: drizzle({ client: sql, schema: masterSchema }) as unknown as MasterDatabase };
  }
  return master.db;
};

export const openTenantDb: typeof Workers.openTenantDb = (url) => {
  const open = tenants.get(url);
  if (open) {
    tenants.delete(url);
    tenants.set(url, open);
    return open.db;
  }

  const sql = postgres(url, { ...OPTIONS, max: 3 });
  const entry = { sql, db: drizzle({ client: sql, schema }) as unknown as Database };
  tenants.set(url, entry);

  for (const [oldest, client] of tenants) {
    if (tenants.size <= tenantPoolLimit()) break;
    tenants.delete(oldest);
    void client.sql.end({ timeout: CLOSE_TIMEOUT });
  }
  return entry.db;
};

/** Close every client: the master's and the tenants'. */
export async function closeDatabases(): Promise<void> {
  const clients = [...(master ? [master.sql] : []), ...[...tenants.values()].map((entry) => entry.sql)];
  master = null;
  tenants.clear();
  await Promise.allSettled(clients.map((sql) => sql.end({ timeout: CLOSE_TIMEOUT })));
}

// node/server.mjs can't import from the bundle it serves, so the bundle leaves
// its shutdown step where the server finds it.
(globalThis as Record<symbol, unknown>)[Symbol.for('weldsuite.admin.shutdown')] = closeDatabases;
