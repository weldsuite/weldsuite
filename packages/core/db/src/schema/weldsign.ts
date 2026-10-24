/**
 * WeldSign — electronic signatures. Tenant DB.
 *
 * An envelope is one signing request: PDFs (`sign_documents`), the people on it
 * (`sign_recipients`) and the boxes they fill in (`sign_fields`). A template is
 * stored in the same tables with `kind = 'template'` and template roles in
 * place of real people; using it copies the rows into a new draft envelope.
 *
 * `sign_events` is the legal evidence trail (opened, consented, signed, …) the
 * certificate-of-completion page is rendered from. It is append-only: no route
 * updates or deletes it, and it outlives a deleted envelope.
 *
 * Files (originals, signature images, the final PDF) live in the private R2
 * bucket under `workspaces/<id>/weldsign/<envelopeId>/`; rows hold only keys.
 * Signing links are routed through the master `sign_link_registry`
 * (weldsign-links.ts).
 *
 * See docs/plans/weldsign.md.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export const SIGN_ENVELOPE_KINDS = ['envelope', 'template'] as const;
export type SignEnvelopeKind = (typeof SIGN_ENVELOPE_KINDS)[number];

export const SIGN_ENVELOPE_STATUSES = [
  'draft',
  'sent',
  'in_progress',
  'completed',
  'declined',
  'voided',
  'expired',
] as const;
export type SignEnvelopeStatus = (typeof SIGN_ENVELOPE_STATUSES)[number];

export const SIGN_RECIPIENT_ROLES = ['signer', 'cc'] as const;
export type SignRecipientRole = (typeof SIGN_RECIPIENT_ROLES)[number];

export const SIGN_RECIPIENT_STATUSES = ['pending', 'sent', 'opened', 'signed', 'declined'] as const;
export type SignRecipientStatus = (typeof SIGN_RECIPIENT_STATUSES)[number];

/** How a signer proves who they are on top of holding the link. */
export const SIGN_AUTH_MODES = ['link', 'email_code', 'access_code'] as const;
export type SignAuthMode = (typeof SIGN_AUTH_MODES)[number];

export const SIGN_FIELD_TYPES = [
  'signature',
  'initials',
  'date_signed',
  'name',
  'email',
  'text',
  'checkbox',
] as const;
export type SignFieldType = (typeof SIGN_FIELD_TYPES)[number];

export const SIGN_EVENT_TYPES = [
  'created',
  'sent',
  'delivered',
  'opened',
  'code_sent',
  'code_verified',
  'code_failed',
  'consented',
  'signed',
  'declined',
  'reminded',
  'resent',
  'recipient_corrected',
  'voided',
  'expired',
  'completed',
  'downloaded',
] as const;
export type SignEventType = (typeof SIGN_EVENT_TYPES)[number];

/** Where an envelope was started from, so the signed PDF can be filed back there. */
export type SignEnvelopeSource = {
  /** Entity type as in the entity-events catalog: 'file', 'company', 'person', 'opportunity', 'quote'. */
  entityType: string;
  entityId: string;
};

/** Page size in PDF points, in page order. */
export type SignPageSize = { width: number; height: number };

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const signEnvelopes = pgTable(
  'sign_envelopes',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // sgn_
    kind: varchar('kind', { length: 20 }).$type<SignEnvelopeKind>().notNull().default('envelope'),
    status: varchar('status', { length: 20 }).$type<SignEnvelopeStatus>().notNull().default('draft'),

    title: varchar('title', { length: 255 }).notNull(),
    /** Message shown in the request email and at the top of the signing page. */
    message: text('message'),

    /** Clerk user id of the member who owns (sends) the envelope. */
    senderUserId: varchar('sender_user_id', { length: 255 }).notNull(),
    senderName: varchar('sender_name', { length: 255 }),
    senderEmail: varchar('sender_email', { length: 320 }),

    /** Signers are emailed group by group (`sign_recipients.routing_order`). */
    signingOrderEnabled: boolean('signing_order_enabled').notNull().default(false),

    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Days after sending before the first reminder; null = no reminders. */
    reminderAfterDays: integer('reminder_after_days'),
    reminderEveryDays: integer('reminder_every_days'),
    reminderMaxCount: integer('reminder_max_count'),

    source: jsonb('source').$type<SignEnvelopeSource>(),
    /** WeldDrive folder the signed PDF is saved to on completion. */
    fileBackFolderId: varchar('file_back_folder_id', { length: 255 }),
    /** Template this envelope was created from. */
    templateId: varchar('template_id', { length: 30 }),

    /** SHA-256 (hex) of the final PDF, certificate page included. */
    finalSha256: varchar('final_sha256', { length: 64 }),
    /** Private-bucket key of the final PDF. */
    finalStorageKey: varchar('final_storage_key', { length: 1000 }),

    voidedReason: text('voided_reason'),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('sign_envelopes_kind_status_idx').on(table.kind, table.status),
    index('sign_envelopes_sender_idx').on(table.senderUserId),
    /** Monthly quota count and the reminder/expiry sweep. */
    index('sign_envelopes_sent_at_idx').on(table.sentAt),
    index('sign_envelopes_expires_at_idx').on(table.expiresAt),
  ],
);

export const signDocuments = pgTable(
  'sign_documents',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // sgd_
    envelopeId: varchar('envelope_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    position: integer('position').notNull().default(0),

    /** Private-bucket key of the original PDF, exactly as uploaded. */
    storageKey: varchar('storage_key', { length: 1000 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    pageCount: integer('page_count').notNull(),
    pageSizes: jsonb('page_sizes').$type<SignPageSize[]>().notNull(),
    /** SHA-256 (hex) of the original bytes. */
    sha256: varchar('sha256', { length: 64 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sign_documents_envelope_idx').on(table.envelopeId, table.position)],
);

export const signRecipients = pgTable(
  'sign_recipients',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // sgr_
    envelopeId: varchar('envelope_id', { length: 30 }).notNull(),
    role: varchar('role', { length: 20 }).$type<SignRecipientRole>().notNull().default('signer'),
    /** Template role name ("Client"); on a template the person fields are empty. */
    roleName: varchar('role_name', { length: 100 }),

    name: varchar('name', { length: 255 }),
    email: varchar('email', { length: 320 }),
    /** CRM person this recipient was picked from. */
    personId: varchar('person_id', { length: 30 }),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),

    /** Recipients with the same order sign in parallel; lowest goes first. */
    routingOrder: integer('routing_order').notNull().default(1),

    authMode: varchar('auth_mode', { length: 20 }).$type<SignAuthMode>().notNull().default('link'),
    /** SHA-256 of the access code the sender shares; never stored in the clear. */
    accessCodeHash: varchar('access_code_hash', { length: 64 }),

    status: varchar('status', { length: 20 }).$type<SignRecipientStatus>().notNull().default('pending'),
    declineReason: text('decline_reason'),
    remindersSent: integer('reminders_sent').notNull().default(0),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }),

    /** Where the signature came from, for the certificate page. */
    signedIp: varchar('signed_ip', { length: 64 }),
    signedUserAgent: text('signed_user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sign_recipients_envelope_idx').on(table.envelopeId, table.routingOrder),
    /** The "action required" folder: envelopes where a member's email is a signer. */
    index('sign_recipients_email_idx').on(table.email),
  ],
);

export const signFields = pgTable(
  'sign_fields',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // sgf_
    envelopeId: varchar('envelope_id', { length: 30 }).notNull(),
    documentId: varchar('document_id', { length: 30 }).notNull(),
    recipientId: varchar('recipient_id', { length: 30 }).notNull(),
    type: varchar('type', { length: 20 }).$type<SignFieldType>().notNull(),

    /** Zero-based page index and box in PDF points, origin top-left. */
    page: integer('page').notNull(),
    x: real('x').notNull(),
    y: real('y').notNull(),
    width: real('width').notNull(),
    height: real('height').notNull(),

    required: boolean('required').notNull().default(true),
    label: varchar('label', { length: 255 }),

    /** Filled value for text, checkbox ('true'/'false'), name, email and date fields. */
    value: text('value'),
    /** Private-bucket key of the adopted signature or initials image. */
    signatureKey: varchar('signature_key', { length: 1000 }),
    filledAt: timestamp('filled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sign_fields_envelope_idx').on(table.envelopeId),
    index('sign_fields_recipient_idx').on(table.recipientId),
  ],
);

/** Append-only evidence trail. */
export const signEvents = pgTable(
  'sign_events',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // sge_
    envelopeId: varchar('envelope_id', { length: 30 }).notNull(),
    /** Null for envelope-level events (sent, voided, completed). */
    recipientId: varchar('recipient_id', { length: 30 }),
    type: varchar('type', { length: 30 }).$type<SignEventType>().notNull(),

    /** Clerk user id when a member acted; null for signers and the system. */
    actorUserId: varchar('actor_user_id', { length: 255 }),
    /** Name and email as shown on the certificate. */
    actorName: varchar('actor_name', { length: 255 }),
    actorEmail: varchar('actor_email', { length: 320 }),
    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),

    /** Event detail: disclosure version, decline reason, document hashes, … */
    details: jsonb('details').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sign_events_envelope_idx').on(table.envelopeId, table.createdAt)],
);

/** One row per workspace: defaults for new envelopes and signer-page branding. */
export const signSettings = pgTable(
  'sign_settings',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // sgs_
    /** Clerk org id; one settings row per workspace. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

    defaultExpiryDays: integer('default_expiry_days').notNull().default(30),
    defaultReminderAfterDays: integer('default_reminder_after_days').default(3),
    defaultReminderEveryDays: integer('default_reminder_every_days').default(3),
    defaultReminderMaxCount: integer('default_reminder_max_count').default(3),

    /** Name signers see as the sender organisation; defaults to the workspace name. */
    brandName: varchar('brand_name', { length: 255 }),
    brandColor: varchar('brand_color', { length: 20 }),
    brandLogoUrl: varchar('brand_logo_url', { length: 1000 }),

    /** WeldDrive folder signed PDFs are filed into when an envelope names none. */
    defaultFileBackFolderId: varchar('default_file_back_folder_id', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('sign_settings_workspace_idx').on(table.workspaceId)],
);

export type SignEnvelope = typeof signEnvelopes.$inferSelect;
export type NewSignEnvelope = typeof signEnvelopes.$inferInsert;
export type SignDocument = typeof signDocuments.$inferSelect;
export type NewSignDocument = typeof signDocuments.$inferInsert;
export type SignRecipient = typeof signRecipients.$inferSelect;
export type NewSignRecipient = typeof signRecipients.$inferInsert;
export type SignField = typeof signFields.$inferSelect;
export type NewSignField = typeof signFields.$inferInsert;
export type SignEvent = typeof signEvents.$inferSelect;
export type NewSignEvent = typeof signEvents.$inferInsert;
export type SignSettings = typeof signSettings.$inferSelect;
export type NewSignSettings = typeof signSettings.$inferInsert;
