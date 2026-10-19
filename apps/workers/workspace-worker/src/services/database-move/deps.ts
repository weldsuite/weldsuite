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
import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { invalidateWorkspaceContexts } from '@weldsuite/core-domain/partners';
import { createProvisioningService, type DatabaseProvisioningService } from '@weldsuite/neon-provisioning';
import type { Env } from '../../index';
import { getMasterDb, type MasterDatabase } from '../../db';
import { MIGRATION_JOURNAL } from '../../generated/tenant-migrations';
import { neonTenantSql } from '../../lib/database-move/neon-sql';
import type { TenantSql } from '../../lib/database-move/types';
import { applyTenantMigrations, type ApplyMigrationsResult } from '../../lib/tenant-migrations';
import { MoveFlowError } from './errors';

/** The provisioning methods a move uses. A test supplies a fake with just these. */
export type MoveProvisioning = Pick<
  DatabaseProvisioningService,
  'prepareMoveTarget' | 'releaseMoveTarget' | 'rotateRolePassword' | 'restartDedicatedEndpoint'
>;

/** What the bundled tenant migrations leave a database at: the shape of `readJournalSummary`, minus the schema. */
export interface BundledJournal {
  count: number;
  /** `max(created_at)` as text. */
  maxCreatedAt: string | null;
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
  /** Encrypt a connection string for storage (keyring v2 when present). Throws when no key is configured. */
  encryptUrl(connectionString: string): Promise<string>;
  /** Decrypt a stored connection string; a stored plaintext one passes through. */
  decryptUrl(stored: string): Promise<string>;
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

/** The journal a freshly migrated database ends with: entry count and the newest `when`. */
export function bundledJournalSummary(): BundledJournal {
  const newest = MIGRATION_JOURNAL.reduce((max, entry) => Math.max(max, entry.when), 0);
  return { count: MIGRATION_JOURNAL.length, maxCreatedAt: MIGRATION_JOURNAL.length > 0 ? String(newest) : null };
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
    async encryptUrl(connectionString) {
      // A move never stores a credential in plaintext, whatever the provisioning fallback does.
      if (!hasKey) throw new MoveFlowError('NOT_CONFIGURED', 'DATABASE_ENCRYPTION_KEY is not configured');
      return encryptField(connectionString, keyring);
    },
    async decryptUrl(stored) {
      return POSTGRES_URL.test(stored) ? stored : decryptField(stored, keyring);
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
