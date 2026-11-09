/**
 * WeldForms — forms and surveys. Tenant DB.
 *
 * A form (`forms`) holds a draft **definition** (blocks, logic, variables,
 * endings; the shape and the rules live in `@weldsuite/forms-engine`) and
 * operational settings. Publishing snapshots the definition into an immutable
 * `form_versions` row; responses point at the version they answered, so
 * editing a live form never changes what earlier respondents saw (ADR
 * FORMS-003).
 *
 * Respondents reach a form through the master `form_link_registry` (public
 * link) or `form_invitation_registry` (personal email link), see
 * weldforms-links.ts. Uploaded files and signatures live in the private R2
 * bucket under `workspaces/<id>/weldforms/<formId>/<responseId>/`; rows hold
 * only keys.
 *
 * Member columns hold Clerk user ids. See docs/plans/weldforms.md.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export const FORM_STATUSES = ['draft', 'published', 'closed'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

/** Who sees a form in the workspace: everyone with `forms:read`, or only its access list. */
export const FORM_ACCESS_LEVELS = ['workspace', 'restricted'] as const;
export type FormAccessLevel = (typeof FORM_ACCESS_LEVELS)[number];

export const FORM_ACCESS_ROLES = ['editor', 'results'] as const;
export type FormAccessRole = (typeof FORM_ACCESS_ROLES)[number];

/** How a respondent is identified (docs/plans/weldforms.md, "Respondent modes"). */
export const FORM_RESPONDENT_MODES = ['anyone', 'verified_email', 'members'] as const;
export type FormRespondentMode = (typeof FORM_RESPONDENT_MODES)[number];

export const FORM_RESPONSE_STATUSES = ['in_progress', 'completed'] as const;
export type FormResponseStatus = (typeof FORM_RESPONSE_STATUSES)[number];

export const FORM_FILE_KINDS = ['upload', 'signature'] as const;
export type FormFileKind = (typeof FORM_FILE_KINDS)[number];

export const FORM_INVITATION_STATUSES = ['sent', 'opened', 'started', 'completed', 'revoked'] as const;
export type FormInvitationStatus = (typeof FORM_INVITATION_STATUSES)[number];

export const FORM_INTEGRATION_KINDS = ['crm', 'desk', 'flow'] as const;
export type FormIntegrationKind = (typeof FORM_INTEGRATION_KINDS)[number];

export const FORM_ACTION_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const;
export type FormActionStatus = (typeof FORM_ACTION_STATUSES)[number];

export const FORM_SUBSCRIPTION_MODES = ['instant', 'daily', 'off'] as const;
export type FormSubscriptionMode = (typeof FORM_SUBSCRIPTION_MODES)[number];

/**
 * The definition as stored. Opaque here on purpose: the schema, its version
 * and every rule that reads it live in `@weldsuite/forms-engine`
 * (`FormDefinition`), which validates it on every write.
 */
export type FormDefinitionJson = Record<string, unknown>;

/** Operational settings; validated by `formSettingsSchema` in `@weldsuite/app-api-client/schemas/weldforms`. */
export type FormSettingsJson = Record<string, unknown>;

/** Theme tokens; validated by `formThemeTokensSchema` in `@weldsuite/forms-engine`. */
export type FormThemeTokensJson = Record<string, unknown>;

/** Integration mapping per kind; validated by the integration schemas in `@weldsuite/app-api-client/schemas/weldforms`. */
export type FormIntegrationConfigJson = Record<string, unknown>;

/** Where and how a response was given. No raw IP is kept (see `ipHash`). */
export type FormResponseMetadata = {
  referrer?: string;
  utm?: Record<string, string>;
  /** `link`, `invitation`, `members`, or the embed mode (`inline`, `popup`, …). */
  source?: string;
  device?: 'desktop' | 'tablet' | 'phone';
  browser?: string;
  os?: string;
  /** ISO 3166-1 alpha-2, from the edge. */
  country?: string;
  /** Milliseconds spent per block id, summed over visits. */
  timings?: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const formFolders = pgTable(
  'form_folders',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // ffd_
    name: varchar('name', { length: 255 }).notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('form_folders_position_idx').on(table.position)],
);

export const forms = pgTable(
  'forms',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // frm_
    folderId: varchar('folder_id', { length: 30 }),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 20 }).$type<FormStatus>().notNull().default('draft'),

    /** The draft. Respondents only ever see a published `form_versions` row. */
    definition: jsonb('definition').$type<FormDefinitionJson>().notNull(),
    settings: jsonb('settings').$type<FormSettingsJson>().notNull(),
    themeId: varchar('theme_id', { length: 30 }),

    /** The id in `forms.weldsuite.org/f/<publicId>`; set on first publish. */
    publicId: varchar('public_id', { length: 20 }),
    publishedVersionId: varchar('published_version_id', { length: 30 }),
    /** True when the draft differs from the published version. */
    hasUnpublishedChanges: boolean('has_unpublished_changes').notNull().default(false),
    /** Bumped on every draft save; a save from an older revision gets 409 (CRM-004). */
    revision: integer('revision').notNull().default(1),

    access: varchar('access', { length: 20 }).$type<FormAccessLevel>().notNull().default('workspace'),
    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),

    /** Completed responses, kept by the submit transaction. */
    responseCount: integer('response_count').notNull().default(0),
    /** Next `form_responses.number`, bumped in the submit transaction. */
    responseCounter: integer('response_counter').notNull().default(0),
    lastResponseAt: timestamp('last_response_at', { withTimezone: true }),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('forms_public_id_idx').on(table.publicId),
    index('forms_folder_idx').on(table.folderId),
    index('forms_owner_idx').on(table.ownerUserId),
    index('forms_status_idx').on(table.status),
  ],
);

export const formVersions = pgTable(
  'form_versions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fve_
    formId: varchar('form_id', { length: 30 }).notNull(),
    number: integer('number').notNull(),
    definition: jsonb('definition').$type<FormDefinitionJson>().notNull(),
    /** The theme as it was on publish, so a later theme edit doesn't restyle answered versions' exports. */
    theme: jsonb('theme').$type<FormThemeTokensJson>(),
    publishedByUserId: varchar('published_by_user_id', { length: 255 }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('form_versions_form_number_idx').on(table.formId, table.number)],
);

/** Members of a restricted form, beyond its owner and `forms:manage`. */
export const formAccess = pgTable(
  'form_access',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fac_
    formId: varchar('form_id', { length: 30 }).notNull(),
    userId: varchar('user_id', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).$type<FormAccessRole>().notNull().default('results'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('form_access_form_user_idx').on(table.formId, table.userId),
    index('form_access_user_idx').on(table.userId),
  ],
);

export const formThemes = pgTable('form_themes', {
  id: varchar('id', { length: 30 }).primaryKey(), // fth_
  name: varchar('name', { length: 255 }).notNull(),
  tokens: jsonb('tokens').$type<FormThemeTokensJson>().notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const formResponses = pgTable(
  'form_responses',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // frs_
    formId: varchar('form_id', { length: 30 }).notNull(),
    versionId: varchar('version_id', { length: 30 }).notNull(),
    /** 1, 2, 3… per form, given on submit; null while in progress. */
    number: integer('number'),
    status: varchar('status', { length: 20 }).$type<FormResponseStatus>().notNull().default('in_progress'),

    /**
     * Answers by block id. Before submit only filled when the form collects
     * partial responses; otherwise an unfinished response keeps progress only.
     */
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
    hidden: jsonb('hidden').$type<Record<string, string>>().notNull().default({}),
    variables: jsonb('variables').$type<Record<string, number | string>>().notNull().default({}),
    endingId: varchar('ending_id', { length: 30 }),
    /** The `score` variable, copied out for sorting and filtering. */
    score: doublePrecision('score'),

    /** Verified email (code or invitation), or the member's email. */
    respondentEmail: varchar('respondent_email', { length: 320 }),
    /** Clerk user id on members-only forms, unless the form hides identities. */
    respondentUserId: varchar('respondent_user_id', { length: 255 }),
    /**
     * Keyed hash of the member on members-only forms that hide identities: it
     * enforces one response per member without saying who answered.
     */
    respondentHash: varchar('respondent_hash', { length: 64 }),
    /** CRM person the response was linked to (CRM integration or invitation). */
    personId: varchar('person_id', { length: 30 }),
    invitationId: varchar('invitation_id', { length: 30 }),

    lastBlockId: varchar('last_block_id', { length: 30 }),
    answeredCount: integer('answered_count').notNull().default(0),
    /** Lowercased text answers, for search. */
    searchText: text('search_text'),
    metadata: jsonb('metadata').$type<FormResponseMetadata>().notNull().default({}),
    /** Keyed hash of the respondent's IP, for duplicate and abuse checks. */
    ipHash: varchar('ip_hash', { length: 64 }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('form_responses_form_status_idx').on(table.formId, table.status, table.submittedAt),
    uniqueIndex('form_responses_form_number_idx').on(table.formId, table.number),
    index('form_responses_email_idx').on(table.respondentEmail),
    index('form_responses_user_idx').on(table.respondentUserId),
    index('form_responses_hash_idx').on(table.formId, table.respondentHash),
    index('form_responses_person_idx').on(table.personId),
    index('form_responses_invitation_idx').on(table.invitationId),
    /** The monthly quota count. */
    index('form_responses_submitted_at_idx').on(table.submittedAt),
  ],
);

export const formResponseFiles = pgTable(
  'form_response_files',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // ffl_
    responseId: varchar('response_id', { length: 30 }).notNull(),
    formId: varchar('form_id', { length: 30 }).notNull(),
    blockId: varchar('block_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<FormFileKind>().notNull().default('upload'),
    /** Private-bucket key. */
    storageKey: varchar('storage_key', { length: 1000 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    contentType: varchar('content_type', { length: 255 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('form_response_files_response_idx').on(table.responseId)],
);

export const formInvitations = pgTable(
  'form_invitations',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fin_
    formId: varchar('form_id', { length: 30 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    name: varchar('name', { length: 255 }),
    personId: varchar('person_id', { length: 30 }),
    userId: varchar('user_id', { length: 255 }),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    status: varchar('status', { length: 20 }).$type<FormInvitationStatus>().notNull().default('sent'),
    subject: varchar('subject', { length: 255 }),
    message: text('message'),
    /**
     * Automatic reminders, fixed when the invitation is sent (the request's
     * schedule or the workspace defaults): first after N days, then every N
     * days, at most M. `reminder_max_count = 0` means no automatic reminders.
     */
    reminderAfterDays: integer('reminder_after_days'),
    reminderEveryDays: integer('reminder_every_days'),
    reminderMaxCount: integer('reminder_max_count').notNull().default(0),
    remindersSent: integer('reminders_sent').notNull().default(0),
    responseId: varchar('response_id', { length: 30 }),
    invitedByUserId: varchar('invited_by_user_id', { length: 255 }).notNull(),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }),
    nextReminderAt: timestamp('next_reminder_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('form_invitations_form_status_idx').on(table.formId, table.status),
    index('form_invitations_email_idx').on(table.formId, table.email),
    /** The reminder sweep. */
    index('form_invitations_next_reminder_idx').on(table.nextReminderAt),
  ],
);

export const formIntegrations = pgTable(
  'form_integrations',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fig_
    formId: varchar('form_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<FormIntegrationKind>().notNull(),
    config: jsonb('config').$type<FormIntegrationConfigJson>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Steps act as this member (ADR FORMS-006). */
    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    /** Why the last run skipped or failed, shown on the integration. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('form_integrations_form_idx').on(table.formId)],
);

/** One row per integration per response: what `ProcessResponse` did. */
export const formResponseActions = pgTable(
  'form_response_actions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fra_
    responseId: varchar('response_id', { length: 30 }).notNull(),
    formId: varchar('form_id', { length: 30 }).notNull(),
    integrationId: varchar('integration_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<FormIntegrationKind>().notNull(),
    status: varchar('status', { length: 20 }).$type<FormActionStatus>().notNull().default('pending'),
    /** The record the step made or updated (entity-events catalog type + id). */
    entityType: varchar('entity_type', { length: 50 }),
    entityId: varchar('entity_id', { length: 30 }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('form_response_actions_response_integration_idx').on(table.responseId, table.integrationId)],
);

export const formSubscriptions = pgTable(
  'form_subscriptions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fsb_
    formId: varchar('form_id', { length: 30 }).notNull(),
    userId: varchar('user_id', { length: 255 }).notNull(),
    mode: varchar('mode', { length: 20 }).$type<FormSubscriptionMode>().notNull().default('instant'),
    /** Responses after this go into the next daily digest. */
    lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('form_subscriptions_form_user_idx').on(table.formId, table.userId),
    index('form_subscriptions_user_idx').on(table.userId),
  ],
);

/** AI summaries, cached per form (whole form: `blockId` null) and per open-text block. */
export const formAiSummaries = pgTable(
  'form_ai_summaries',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fas_
    formId: varchar('form_id', { length: 30 }).notNull(),
    blockId: varchar('block_id', { length: 30 }),
    /** Completed responses the summary was made from; a different count means stale. */
    responseCount: integer('response_count').notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('form_ai_summaries_form_idx').on(table.formId, table.blockId)],
);

/** One row per workspace. */
export const formSettings = pgTable('form_settings', {
  id: varchar('id', { length: 30 }).primaryKey(), // fst_
  defaultThemeId: varchar('default_theme_id', { length: 30 }),
  /** Display name on invitation emails; the workspace name when empty. */
  senderName: varchar('sender_name', { length: 255 }),
  /** Automatic invitation reminders: first after N days, then every N days, at most M. */
  reminderAfterDays: integer('reminder_after_days'),
  reminderEveryDays: integer('reminder_every_days'),
  reminderMaxCount: integer('reminder_max_count').notNull().default(3),
  /** "Made with WeldForms" on public forms; only paid plans may switch it off. */
  showBadge: boolean('show_badge').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Form = typeof forms.$inferSelect;
export type NewForm = typeof forms.$inferInsert;
export type FormVersion = typeof formVersions.$inferSelect;
export type FormFolder = typeof formFolders.$inferSelect;
export type FormTheme = typeof formThemes.$inferSelect;
export type FormResponse = typeof formResponses.$inferSelect;
export type NewFormResponse = typeof formResponses.$inferInsert;
export type FormResponseFile = typeof formResponseFiles.$inferSelect;
export type FormInvitation = typeof formInvitations.$inferSelect;
export type FormIntegration = typeof formIntegrations.$inferSelect;
export type FormResponseAction = typeof formResponseActions.$inferSelect;
export type FormSubscription = typeof formSubscriptions.$inferSelect;
export type FormAiSummary = typeof formAiSummaries.$inferSelect;
export type FormSettingsRow = typeof formSettings.$inferSelect;
