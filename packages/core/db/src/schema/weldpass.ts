/**
 * WeldPass — secret management. Tenant DB.
 *
 * A vault project belongs to one workspace. Everything below it hangs off
 * `project_id`, so `workspaceId` is checked once when the project is resolved
 * and every subsequent query is scoped through it.
 *
 * Values are never stored in the clear. Each secret carries its own AES-256-GCM
 * data key (`dek_wrapped`, wrapped by the project KEK) and the project KEK is
 * itself wrapped by the worker's root key. See
 * `apps/workers/app-api/src/services/weldpass/envelope.ts`.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/** Deploy targets WeldPass can push a vault environment to. */
export type WeldPassProvider = 'cloudflare_workers' | 'cloudflare_pages' | 'vercel';

/** Per-provider settings for a sync target. Validated with Zod at the route. */
export type WeldPassSyncTargetConfig =
  | {
      provider: 'cloudflare_workers';
      accountId: string;
      /** Deployed Worker script name, e.g. "weldsuite-app-api-test". */
      scriptName: string;
    }
  | {
      provider: 'cloudflare_pages';
      accountId: string;
      projectName: string;
      /** Pages only has these two deployment configs. */
      environment: 'production' | 'preview';
    }
  | {
      provider: 'vercel';
      /** Project id (prj_…) or project name. */
      projectId: string;
      /** Set for team-owned projects. */
      teamId?: string;
      targets: Array<'production' | 'preview' | 'development'>;
    };

/** Non-secret provider metadata stored next to an encrypted API token. */
export type WeldPassCredentialMetadata = {
  /** Cloudflare account id — the token alone does not identify one. */
  accountId?: string;
  /** Vercel team id for team-scoped tokens. */
  teamId?: string;
};

/** Per-key outcome recorded on a sync run. */
export type WeldPassSyncRunDetail = {
  key: string;
  action: 'pushed' | 'removed' | 'skipped' | 'failed';
  message?: string;
};

export type WeldPassSecretAction = 'created' | 'updated' | 'deleted' | 'restored';
export type WeldPassSyncStatus = 'idle' | 'running' | 'success' | 'failed' | 'partial';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const weldpassProjects = pgTable(
  'weldpass_projects',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    /** Clerk org id — the tenant DB is per-workspace, kept for defence in depth. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    description: text('description'),

    /** Project key-encryption key, wrapped by the worker root key ("v1:iv:ct"). */
    kekWrapped: text('kek_wrapped').notNull(),
    /** Which root key wrapped it, so the root key can be rotated. */
    rootKeyVersion: varchar('root_key_version', { length: 10 }).notNull().default('v1'),

    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_projects_workspace_idx').on(table.workspaceId),
    uniqueIndex('weldpass_projects_workspace_slug_idx').on(table.workspaceId, table.slug),
  ],
);

/** Environments inside a vault project (development, preview, production, …). */
export const weldpassEnvironments = pgTable(
  'weldpass_environments',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 30 }).notNull(),

    name: varchar('name', { length: 60 }).notNull(),
    /** URL-safe key used by the API, unique within the project. */
    slug: varchar('slug', { length: 40 }).notNull(),

    /** Extra confirmation before syncing or revealing. */
    isProduction: boolean('is_production').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_environments_project_idx').on(table.projectId),
    uniqueIndex('weldpass_environments_project_slug_idx').on(table.projectId, table.slug),
  ],
);

/** One secret in one environment. Current version only — history lives next door. */
export const weldpassSecrets = pgTable(
  'weldpass_secrets',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    environmentId: varchar('environment_id', { length: 30 }).notNull(),

    /** Env-var name, e.g. DATABASE_URL. Uppercase/underscore enforced at the route. */
    key: varchar('key', { length: 255 }).notNull(),

    /** AES-256-GCM ciphertext of the value, "iv:ct" hex. */
    ciphertext: text('ciphertext').notNull(),
    /** The value's data key, wrapped by the project KEK. */
    dekWrapped: text('dek_wrapped').notNull(),

    /** SHA-256 of the plaintext — lets sync detect drift without decrypting. */
    checksum: varchar('checksum', { length: 64 }).notNull(),
    /** Plaintext length, for the masked UI. */
    valueLength: integer('value_length').notNull().default(0),
    /** Last few plaintext characters, so a masked row is still recognisable. */
    valueHint: varchar('value_hint', { length: 8 }),

    note: text('note'),
    version: integer('version').notNull().default(1),

    createdBy: varchar('created_by', { length: 255 }),
    updatedBy: varchar('updated_by', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_secrets_project_idx').on(table.projectId),
    index('weldpass_secrets_environment_idx').on(table.environmentId),
    uniqueIndex('weldpass_secrets_environment_key_idx').on(table.environmentId, table.key),
  ],
);

/** Append-only history so a bad edit can be rolled back. */
export const weldpassSecretVersions = pgTable(
  'weldpass_secret_versions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    secretId: varchar('secret_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),

    version: integer('version').notNull(),
    action: varchar('action', { length: 20 }).$type<WeldPassSecretAction>().notNull(),

    ciphertext: text('ciphertext').notNull(),
    dekWrapped: text('dek_wrapped').notNull(),
    checksum: varchar('checksum', { length: 64 }).notNull(),

    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('weldpass_secret_versions_secret_idx').on(table.secretId),
    uniqueIndex('weldpass_secret_versions_secret_version_idx').on(table.secretId, table.version),
  ],
);

/** Cloudflare / Vercel API tokens, envelope-encrypted like any other secret. */
export const weldpassProviderCredentials = pgTable(
  'weldpass_provider_credentials',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 30 }).notNull(),

    provider: varchar('provider', { length: 30 }).$type<WeldPassProvider>().notNull(),
    name: varchar('name', { length: 100 }).notNull(),

    ciphertext: text('ciphertext').notNull(),
    dekWrapped: text('dek_wrapped').notNull(),
    /** Non-secret shape of the token: account id, team id. */
    metadata: jsonb('metadata').$type<WeldPassCredentialMetadata>().notNull().default({}),

    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastVerifyError: text('last_verify_error'),

    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_provider_credentials_project_idx').on(table.projectId),
    index('weldpass_provider_credentials_provider_idx').on(table.provider),
  ],
);

/** "Push environment X to Worker/Pages/Vercel Y with credential Z." */
export const weldpassSyncTargets = pgTable(
  'weldpass_sync_targets',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    environmentId: varchar('environment_id', { length: 30 }).notNull(),
    credentialId: varchar('credential_id', { length: 30 }).notNull(),

    provider: varchar('provider', { length: 30 }).$type<WeldPassProvider>().notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    config: jsonb('config').$type<WeldPassSyncTargetConfig>().notNull(),

    /** Push on every secret write in this environment. */
    autoSync: boolean('auto_sync').notNull().default(false),
    /** Delete remote keys that no longer exist in the vault. */
    prune: boolean('prune').notNull().default(false),

    status: varchar('status', { length: 20 })
      .$type<WeldPassSyncStatus>()
      .notNull()
      .default('idle'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncedCount: integer('last_synced_count').notNull().default(0),
    lastError: text('last_error'),

    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_sync_targets_project_idx').on(table.projectId),
    index('weldpass_sync_targets_environment_idx').on(table.environmentId),
    index('weldpass_sync_targets_credential_idx').on(table.credentialId),
  ],
);

/** One push attempt against one target. */
export const weldpassSyncRuns = pgTable(
  'weldpass_sync_runs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    targetId: varchar('target_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    environmentId: varchar('environment_id', { length: 30 }).notNull(),

    status: varchar('status', { length: 20 }).$type<WeldPassSyncStatus>().notNull(),
    trigger: varchar('trigger', { length: 20 }).$type<'manual' | 'auto'>().notNull(),

    pushed: integer('pushed').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    failed: integer('failed').notNull().default(0),

    error: text('error'),
    /** Per-key outcomes — keys only, never values. */
    details: jsonb('details').$type<WeldPassSyncRunDetail[]>().notNull().default([]),

    triggeredBy: varchar('triggered_by', { length: 255 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_sync_runs_target_idx').on(table.targetId),
    index('weldpass_sync_runs_project_idx').on(table.projectId),
    index('weldpass_sync_runs_started_at_idx').on(table.startedAt),
  ],
);

/**
 * Who touched what.
 *
 * WeldPass keeps its own trail rather than riding the shared entity-event bus:
 * that bus feeds workflows, analytics and AI agents, and neither secret
 * metadata nor production credential names belong in any of them. Reveals are
 * recorded alongside writes — for a secrets manager, "who read this" matters as
 * much as "who changed it".
 */
export const weldpassAuditEvents = pgTable(
  'weldpass_audit_events',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    environmentId: varchar('environment_id', { length: 30 }),
    secretId: varchar('secret_id', { length: 30 }),

    actorId: varchar('actor_id', { length: 255 }).notNull(),
    /** e.g. secret.revealed, secret.updated, sync.pushed, credential.created. */
    action: varchar('action', { length: 40 }).notNull(),
    /** Secret key or target name — never a value. */
    targetKey: varchar('target_key', { length: 255 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: varchar('ip', { length: 45 }),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('weldpass_audit_events_project_idx').on(table.projectId),
    index('weldpass_audit_events_secret_idx').on(table.secretId),
    index('weldpass_audit_events_created_at_idx').on(table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type WeldPassProject = typeof weldpassProjects.$inferSelect;
export type NewWeldPassProject = typeof weldpassProjects.$inferInsert;
export type WeldPassEnvironment = typeof weldpassEnvironments.$inferSelect;
export type NewWeldPassEnvironment = typeof weldpassEnvironments.$inferInsert;
export type WeldPassSecret = typeof weldpassSecrets.$inferSelect;
export type NewWeldPassSecret = typeof weldpassSecrets.$inferInsert;
export type WeldPassSecretVersion = typeof weldpassSecretVersions.$inferSelect;
export type NewWeldPassSecretVersion = typeof weldpassSecretVersions.$inferInsert;
export type WeldPassProviderCredential = typeof weldpassProviderCredentials.$inferSelect;
export type NewWeldPassProviderCredential = typeof weldpassProviderCredentials.$inferInsert;
export type WeldPassSyncTarget = typeof weldpassSyncTargets.$inferSelect;
export type NewWeldPassSyncTarget = typeof weldpassSyncTargets.$inferInsert;
export type WeldPassSyncRun = typeof weldpassSyncRuns.$inferSelect;
export type NewWeldPassSyncRun = typeof weldpassSyncRuns.$inferInsert;
export type WeldPassAuditEvent = typeof weldpassAuditEvents.$inferSelect;
export type NewWeldPassAuditEvent = typeof weldpassAuditEvents.$inferInsert;
