import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — Messenger widget configuration.
 *
 * Spaces model (v1: Home + Messages + Help). Replaces the old page-based
 * helpdesk_widget_settings.
 */

export interface DeskWidgetHomeConfig {
  greeting?: string;
  /** Show help-center search on Home. */
  showSearch: boolean;
  /** Show expected reply time (from office hours / team config). */
  showReplyTime: boolean;
  /** External/deep links rendered as cards on Home. */
  links?: { label: string; url: string; icon?: string }[];
}

export interface DeskWidgetBranding {
  primaryColor?: string;
  backgroundColor?: string;
  launcherIcon?: 'chat' | 'help' | 'custom';
  launcherIconUrl?: string;
  position?: 'right' | 'left';
  borderRadius?: number;
}

export const deskWidgetSettings = pgTable(
  'desk_widget_settings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** One row per tenant. */
    scope: varchar('scope', { length: 10 }).notNull().default('default'),

    /** Public widget id used by the embed snippet. */
    widgetId: varchar('widget_id', { length: 40 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),

    // Spaces (Messages is always on)
    homeEnabled: boolean('home_enabled').notNull().default(true),
    helpEnabled: boolean('help_enabled').notNull().default(true),
    home: jsonb('home').$type<DeskWidgetHomeConfig>(),

    branding: jsonb('branding').$type<DeskWidgetBranding>(),

    /**
     * HMAC secret for identity verification of logged-in users. When set,
     * user identification requires a valid user-hash.
     */
    identityVerificationSecret: text('identity_verification_secret'),
    requireIdentityVerification: boolean('require_identity_verification').notNull().default(false),

    /** Ask anonymous visitors for their email before/while chatting. */
    emailCollection: varchar('email_collection', { length: 15 })
      .$type<'always' | 'outside_hours' | 'never'>()
      .notNull()
      .default('outside_hours'),

    /** Domains allowed to embed the widget; empty = any. */
    allowedDomains: jsonb('allowed_domains').$type<string[]>(),
  },
  (table) => [
    uniqueIndex('desk_widget_settings_scope_idx').on(table.scope),
    uniqueIndex('desk_widget_settings_widget_id_idx').on(table.widgetId),
  ],
);

export type DeskWidgetSettings = typeof deskWidgetSettings.$inferSelect;
export type NewDeskWidgetSettings = typeof deskWidgetSettings.$inferInsert;
