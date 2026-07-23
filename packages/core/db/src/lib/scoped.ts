import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from '../schema';
import type { TenantTier } from '../schema/master';

// Database instance type — base class shared by neon-serverless (platform)
// and neon-http (mcp-server). Both extend PgDatabase, so this is the
// common surface for select/insert/update/delete.
type DbInstance = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface ScopedDbOptions {
  db: DbInstance;
  userId?: string;
  tier: TenantTier;
}

// Returns the workspace-scoped Drizzle instance plus tenant identity.
// Callers query Drizzle directly via the returned `db` field; there is no
// per-entity helper API here (an earlier version exposed one but it had
// drifted from the schema and was unused — removed for safety).
export function createScopedDb(options: ScopedDbOptions) {
  return {
    db: options.db,
    userId: options.userId,
    tier: options.tier,
  };
}

export type ScopedDb = ReturnType<typeof createScopedDb>;

// Re-export auth utilities for backward compatibility
export {
  getScopedDb,
  getScopedDbOptional,
  getScopedDbForWorkspace,
  getWorkspaceId,
  getUserId,
  getUserIdOptional,
  getTenant,
  autoAcceptPendingInvites,
} from './auth';
