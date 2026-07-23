import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  real,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { mailTemplates } from './mail-templates';

// Campaign status enum
export const mailCampaignStatusEnum = pgEnum('mail_campaign_status', [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'paused',
  'cancelled',
  'failed',
]);

// Winner criteria enum
export const mailCampaignWinnerCriteriaEnum = pgEnum('mail_campaign_winner_criteria', [
  'open_rate',
  'click_rate',
]);

// Recipient list interface (stored as JSONB)
export interface MailRecipientList {
  /**
   * After the Companies/People migration, `'people'` is the canonical type;
   * `'contacts'` is kept as an alias for in-flight campaigns and is mapped
   * 1:1 to People at send time.
   */
  type: 'contacts' | 'people' | 'segments' | 'manual' | 'csv';
  /** @deprecated Use `personIds` after migration. */
  contactIds?: string[];
  personIds?: string[];
  segmentIds?: string[];
  emails?: { email: string; name?: string }[];
  csvUrl?: string;
  excludeUnsubscribed?: boolean;
  excludeBounced?: boolean;
}

// Campaign variant interface (stored as JSONB)
export interface MailCampaignVariant {
  id: string;
  name: string;
  subject?: string;
  content?: string;
  percentage?: number;
  sentCount?: number;
  performance?: {
    delivered: number;
    opened: number;
    clicked: number;
    unsubscribed: number;
    complained: number;
    bounced: number;
  };
}

// UTM parameters interface (stored as JSONB)
export interface MailUtmParameters {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

// Mail Campaigns table
export const mailCampaigns = pgTable('mail_campaigns', {
  id: varchar('id', { length: 30 }).primaryKey(),
  templateId: varchar('template_id', { length: 30 }).references(() => mailTemplates.id),

  // Campaign Information
  name: varchar('name', { length: 255 }).notNull(),
  subject: varchar('subject', { length: 998 }).notNull(),
  preheader: varchar('preheader', { length: 500 }),

  // Content
  htmlContent: text('html_content').notNull(),
  textContent: text('text_content'),

  // Recipients
  recipientList: jsonb('recipient_list').$type<MailRecipientList>().notNull(),
  totalRecipients: integer('total_recipients').notNull().default(0),
  segments: jsonb('segments').$type<string[]>(),

  // Sender
  fromName: varchar('from_name', { length: 255 }).notNull(),
  fromEmail: varchar('from_email', { length: 255 }).notNull(),
  replyToEmail: varchar('reply_to_email', { length: 255 }),

  // Schedule
  scheduledAt: timestamp('scheduled_at'),
  sentAt: timestamp('sent_at'),
  status: mailCampaignStatusEnum('status').notNull().default('draft'),

  // Performance counts
  sentCount: integer('sent_count').default(0),
  deliveredCount: integer('delivered_count').default(0),
  bouncedCount: integer('bounced_count').default(0),
  openedCount: integer('opened_count').default(0),
  clickedCount: integer('clicked_count').default(0),
  unsubscribedCount: integer('unsubscribed_count').default(0),
  complaintCount: integer('complaint_count').default(0),

  // Performance rates (calculated)
  deliveryRate: real('delivery_rate'),
  openRate: real('open_rate'),
  clickRate: real('click_rate'),
  bounceRate: real('bounce_rate'),
  unsubscribeRate: real('unsubscribe_rate'),

  // A/B Testing
  isAbTest: boolean('is_ab_test').default(false),
  variants: jsonb('variants').$type<MailCampaignVariant[]>(),
  winnerCriteria: mailCampaignWinnerCriteriaEnum('winner_criteria'),
  winnerVariantId: varchar('winner_variant_id', { length: 30 }),

  // Tracking Settings
  trackOpens: boolean('track_opens').notNull().default(true),
  trackClicks: boolean('track_clicks').notNull().default(true),
  googleAnalytics: boolean('google_analytics').default(false),
  utmParameters: jsonb('utm_parameters').$type<MailUtmParameters>(),

  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_campaigns_template_id_idx').on(table.templateId),
  index('mail_campaigns_status_idx').on(table.status),
  index('mail_campaigns_scheduled_at_idx').on(table.scheduledAt),
  index('mail_campaigns_sent_at_idx').on(table.sentAt),
]);

export type MailCampaign = typeof mailCampaigns.$inferSelect;
export type NewMailCampaign = typeof mailCampaigns.$inferInsert;
