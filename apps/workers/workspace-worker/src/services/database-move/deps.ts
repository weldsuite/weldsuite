/**
 * What a database move needs from the outside world, in one injectable bag:
 * the master DB, the Neon provisioning service, tenant connections, the
 * migration applier, URL encryption and the cache purge. The Workflow and the
 * recovery functions take a `MoveDeps`; production builds one from the Worker
 * env with {@link createMoveDeps}, the tests hand in fakes.
 *
 * Secrets: the encryption keyring and the Neon key are read from the env here
 * and never leave this file except inside the objects that need them.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { decryptWorkspaceDatabaseUrl, encryptWorkspaceDatabaseUrl, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { invalidateWorkspaceContexts } from '@weldsuite/core-domain/partners';
import { createProvisioningService, type DatabaseProvisioningService } from '@weldsuite/neon-provisioning';
import type { Env } from '../../index';
import { getMasterDb, type MasterDatabase } from '../../db';
import type { TenantJournalEntry } from '@weldsuite/db/lib/tenant-journal';
import { MIGRATION_JOURNAL } from '../../generated/tenant-migrations';
import { neonTenantSql } from '../../lib/database-move/neon-sql';
import type { TenantSql } from '../../lib/database-move/types';
import { applyTenantMigrations, bundledJournalEntries, type ApplyMigrationsResult } from '../../lib/tenant-migrations';
import { MoveFlowError } from './errors';

/** The provisioning methods a move uses. A test supplies a fake with just these. */
export type MoveProvisioning = Pick<
  DatabaseProvisioningService,
  'prepareMoveTarget' | 'releaseMoveTarget' | 'rotateRolePassword' | 'restartDedicatedEndpoint'
>;

/** The bundled tenant journal: its entries (what a database is judged against), and its size and newest `when` for messages. */
export interface BundledJournal {
  count: number;
  /** `max(created_at)` as text. */
  maxCreatedAt: string | null;
  entries: TenantJournalEntry[];
}

export interface WorkspaceCacheTarget {
  workspaceId: string;
  clerkOrgId: string | null;
}

export interface MoveDeps {
  masterDb: MasterDatabase;
  provisioning: MoveProvisioning;
  /** A tenant connection over a connection string. The string is never logged. */
  connect(connectionString: string): TenantSql;
  /** Apply the bundled migrations to the database at `connectionString`, at most `statementBudget` statements per call. */
  migrate(connectionString: string, statementBudget: number): Promise<ApplyMigrationsResult>;
  /**
   * Encrypt a workspace's connection string for storage (keyring v2 when present;
   * AAD-bound to the workspace once FIELD_ENCRYPTION_AAD_WRITES is on). Throws
   * when no key is configured.
   */
  encryptUrl(connectionString: string, workspaceId: string): Promise<string>;
  /** Decrypt a workspace's stored connection string; a stored plaintext one passes through. */
  decryptUrl(stored: string, workspaceId: string): Promise<string>;
  bundledJournal: BundledJournal;
  /** Drop every cached copy of the workspace's tenant resolution. Never throws. */
  purgeCaches(target: WorkspaceCacheTarget): Promise<void>;
  /** How long the old database stays (read-only) after the switch. */
  retentionDays: number;
  /** Region used when the workspace row has none. */
  defaultRegion: string;
  now(): Date;
}

export const DEFAULT_DATABASE_MOVE_RETENTION_DAYS = 7;
const DEFAULT_REGION = 'aws-eu-central-1';

/** `DATABASE_MOVE_RETENTION_DAYS` as a positive number of days; anything else means the default. */
export function retentionDaysFromEnv(env: Pick<Env, 'DATABASE_MOVE_RETENTION_DAYS'>): number {
  const parsed = Number(env.DATABASE_MOVE_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DATABASE_MOVE_RETENTION_DAYS;
}

/** The journal a freshly migrated database ends with: its entries, entry count and the newest `when`. */
export function bundledJournalSummary(): BundledJournal {
  const newest = MIGRATION_JOURNAL.reduce((max, entry) => Math.max(max, entry.when), 0);
  return {
    count: MIGRATION_JOURNAL.length,
    maxCreatedAt: MIGRATION_JOURNAL.length > 0 ? String(newest) : null,
    entries: bundledJournalEntries(),
  };
}

const POSTGRES_URL = /^postgres(?:ql)?:\/\//;

export function createMoveDeps(env: Env): MoveDeps {
  const keyring = keyringFromEnv(env);
  const hasKey = Boolean(keyring.v1 || keyring.v2);
  const defaultRegion = env.NEON_DEFAULT_REGION || DEFAULT_REGION;

  return {
    masterDb: getMasterDb(env),
    provisioning: createProvisioningService({
      NEON_API_KEY: env.NEON_API_KEY,
      NEON_ORG_ID: env.NEON_ORG_ID,
      NEON_DEFAULT_REGION: defaultRegion,
      DATABASE_ENCRYPTION_KEY: env.DATABASE_ENCRYPTION_KEY,
      DATABASE_ENCRYPTION_KEY_V2: env.DATABASE_ENCRYPTION_KEY_V2,
    }),
    connect: neonTenantSql,
    migrate: (connectionString, statementBudget) =>
      applyTenantMigrations(drizzleNeonHttp({ client: neon(connectionString) }), { statementBudget }),
    async encryptUrl(connectionString, workspaceId) {
      // A move never stores a credential in plaintext, whatever the provisioning fallback does.
      if (!hasKey) throw new MoveFlowError('NOT_CONFIGURED', 'DATABASE_ENCRYPTION_KEY is not configured');
      return encryptWorkspaceDatabaseUrl(connectionString, workspaceId, keyring);
    },
    async decryptUrl(stored, workspaceId) {
      return POSTGRES_URL.test(stored) ? stored : decryptWorkspaceDatabaseUrl(stored, workspaceId, keyring);
    },
    bundledJournal: bundledJournalSummary(),
    purgeCaches: ({ workspaceId, clerkOrgId }) =>
      invalidateWorkspaceContexts(env.WORKSPACE_CACHE, [clerkOrgId], {
        apiCache: env.API_CACHE,
        workspaceIds: [workspaceId],
        databaseKeys: true,
      }),
    retentionDays: retentionDaysFromEnv(env),
    defaultRegion,
    now: () => new Date(),
  };
}
