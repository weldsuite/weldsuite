/**
 * WeldPass — secret management and the team password manager. Tenant DB.
 *
 * A vault project belongs to one workspace. Everything below it hangs off
 * `project_id`, so `workspaceId` is checked once when the project is resolved
 * and every subsequent query is scoped through it.
 *
 * Values are never stored in the clear. Each secret carries its own AES-256-GCM
 * data key (`dek_wrapped`, wrapped by the project KEK) and the project KEK is
 * itself wrapped by the worker's root key. See
 * `apps/workers/pass-api/src/services/weldpass/envelope.ts`.
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
import { sql } from 'drizzle-orm';

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
// Password manager
//
// A second surface next to the developer vaults above. Projects are opened by
// workspace permission (`secrets:*`); these vaults are opened by *membership*:
// a personal vault belongs to exactly one person, a shared vault to the people
// listed in `weldpass_vault_members`. The envelope is the same — each vault has
// its own KEK wrapped by the worker root key — so a shared vault's members
// reach the same ciphertext through an access check, not through a copy.
// ---------------------------------------------------------------------------

export type WeldPassVaultKind = 'personal' | 'shared';

/**
 * viewer  — list and reveal items
 * editor  — also add, edit, move and delete items
 * manager — also rename or delete the vault and manage its members
 */
export type WeldPassVaultRole = 'viewer' | 'editor' | 'manager';

export type WeldPassItemType = 'login' | 'note' | 'card';
export type WeldPassItemAction = 'created' | 'updated' | 'deleted' | 'restored';

export const weldpassVaults = pgTable(
  'weldpass_vaults',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    /** Clerk org id — the tenant DB is per-workspace, kept for defence in depth. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

    kind: varchar('kind', { length: 20 }).$type<WeldPassVaultKind>().notNull(),
    /** Set on a personal vault: the one user who can open it. Null when shared. */
    ownerId: varchar('owner_id', { length: 255 }),

    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),

    /** Vault key-encryption key, wrapped by the worker root key ("v1:iv:ct"). */
    kekWrapped: text('kek_wrapped').notNull(),
    rootKeyVersion: varchar('root_key_version', { length: 10 }).notNull().default('v1'),

    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_vaults_workspace_idx').on(table.workspaceId),
    // One personal vault per person. It is created on first use, so two tabs
    // opening WeldPass at once must not end up with two.
    uniqueIndex('weldpass_vaults_personal_owner_idx')
      .on(table.workspaceId, table.ownerId)
      .where(sql`${table.kind} = 'personal' AND ${table.deletedAt} IS NULL`),
  ],
);

/** Who can open a shared vault. Personal vaults have no rows here. */
export const weldpassVaultMembers = pgTable(
  'weldpass_vault_members',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    vaultId: varchar('vault_id', { length: 30 }).notNull(),
    /** Clerk user id, matching `workspace_members.user_id`. */
    userId: varchar('user_id', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).$type<WeldPassVaultRole>().notNull(),

    addedBy: varchar('added_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('weldpass_vault_members_vault_user_idx').on(table.vaultId, table.userId),
    index('weldpass_vault_members_user_idx').on(table.userId),
  ],
);

/**
 * One login, secure note or payment card.
 *
 * Everything a person would call secret — password, TOTP seed, note body, card
 * number — is in `ciphertext` as one JSON document. The plain columns are what
 * a list needs to render and what the browser extension matches a page
 * against: a title, a display line and the site.
 */
export const weldpassItems = pgTable(
  'weldpass_items',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    vaultId: varchar('vault_id', { length: 30 }).notNull(),

    type: varchar('type', { length: 20 }).$type<WeldPassItemType>().notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    /** Login username, or "•••• 4242" for a card. Never a secret. */
    subtitle: varchar('subtitle', { length: 255 }),
    url: text('url'),
    /** Lower-cased hostname of `url`, for matching a page to its logins. */
    host: varchar('host', { length: 255 }),
    hasTotp: boolean('has_totp').notNull().default(false),

    /** AES-256-GCM ciphertext of the item's fields as JSON. */
    ciphertext: text('ciphertext').notNull(),
    /** The item's data key, wrapped by the vault KEK. */
    dekWrapped: text('dek_wrapped').notNull(),

    /** When a login's password last changed — drives the "old password" check. */
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),

    createdBy: varchar('created_by', { length: 255 }),
    updatedBy: varchar('updated_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldpass_items_vault_idx').on(table.vaultId),
    index('weldpass_items_host_idx').on(table.host),
  ],
);

/** Append-only item history, so an overwritten password is recoverable. */
export const weldpassItemVersions = pgTable(
  'weldpass_item_versions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    itemId: varchar('item_id', { length: 30 }).notNull(),
    vaultId: varchar('vault_id', { length: 30 }).notNull(),

    version: integer('version').notNull(),
    action: varchar('action', { length: 20 }).$type<WeldPassItemAction>().notNull(),

    ciphertext: text('ciphertext').notNull(),
    dekWrapped: text('dek_wrapped').notNull(),

    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('weldpass_item_versions_item_idx').on(table.itemId),
    uniqueIndex('weldpass_item_versions_item_version_idx').on(table.itemId, table.version),
  ],
);

/**
 * The password manager's trail: who opened, changed or shared what. Kept apart
 * from `weldpass_audit_events`, which is keyed by project and environment.
 * Titles and member ids only — a password never reaches this table.
 */
export const weldpassVaultEvents = pgTable(
  'weldpass_vault_events',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    vaultId: varchar('vault_id', { length: 30 }).notNull(),
    itemId: varchar('item_id', { length: 30 }),

    actorId: varchar('actor_id', { length: 255 }).notNull(),
    /** e.g. item.revealed, item.updated, member.added, vault.created. */
    action: varchar('action', { length: 40 }).notNull(),
    /** Item title or the affected member's user id — never a value. */
    targetLabel: varchar('target_label', { length: 255 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: varchar('ip', { length: 45 }),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('weldpass_vault_events_vault_idx').on(table.vaultId),
    index('weldpass_vault_events_item_idx').on(table.itemId),
    index('weldpass_vault_events_created_at_idx').on(table.createdAt),
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
export type WeldPassVault = typeof weldpassVaults.$inferSelect;
export type NewWeldPassVault = typeof weldpassVaults.$inferInsert;
export type WeldPassVaultMember = typeof weldpassVaultMembers.$inferSelect;
export type NewWeldPassVaultMember = typeof weldpassVaultMembers.$inferInsert;
export type WeldPassItem = typeof weldpassItems.$inferSelect;
export type NewWeldPassItem = typeof weldpassItems.$inferInsert;
export type WeldPassItemVersion = typeof weldpassItemVersions.$inferSelect;
export type NewWeldPassItemVersion = typeof weldpassItemVersions.$inferInsert;
export type WeldPassVaultEvent = typeof weldpassVaultEvents.$inferSelect;
export type NewWeldPassVaultEvent = typeof weldpassVaultEvents.$inferInsert;
