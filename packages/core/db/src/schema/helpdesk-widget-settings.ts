import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  index,
} from 'drizzle-orm/pg-core';

export const helpdeskWidgetSettings = pgTable('helpdesk_widget_settings', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Widget identification
  widgetId: varchar('widget_id', { length: 50 }),
  widgetName: varchar('widget_name', { length: 255 }),

  // Page visibility
  pageHome: boolean('page_home').default(true),
  pageChat: boolean('page_chat').default(true),
  pageHelp: boolean('page_help').default(true),
  pageParcelTracking: boolean('page_parcel_tracking').default(false),
  pageChangelog: boolean('page_changelog').default(true),
  pageNews: boolean('page_news').default(true),
  pageFeedback: boolean('page_feedback').default(true),
  pageAnnouncements: boolean('page_announcements').default(true),
  pageEventSignUp: boolean('page_event_sign_up').default(false),

  // Colors
  colorPrimary: varchar('color_primary', { length: 20 }),
  colorButton: varchar('color_button', { length: 20 }),
  colorButtonText: varchar('color_button_text', { length: 20 }),
  colorLauncher: varchar('color_launcher', { length: 20 }),
  colorHeader: varchar('color_header', { length: 20 }),
  colorAccent: varchar('color_accent', { length: 20 }),

  // Styling
  borderRadius: varchar('border_radius', { length: 20 }),
  fontSize: varchar('font_size', { length: 20 }),
  typographyText: varchar('typography_text', { length: 20 }),
  typographyBackground: varchar('typography_background', { length: 20 }),

  // Behavior
  startingPage: varchar('starting_page', { length: 50 }),
  position: varchar('position', { length: 20 }),
  autoOpen: boolean('auto_open').default(false),
  showWelcomeMessage: boolean('show_welcome_message').default(true),
  welcomeMessage: varchar('welcome_message', { length: 500 }),

  // Branding
  companyLogoUrl: varchar('company_logo_url', { length: 500 }),
  showBranding: boolean('show_branding').default(true),

  // Email collection behavior
  emailCollection: varchar('email_collection', { length: 30 }).default('none'),

  // Chat interface colors
  chatBackgroundColor: varchar('chat_background_color', { length: 20 }),
  userBubbleColor: varchar('user_bubble_color', { length: 20 }),
  userBubbleTextColor: varchar('user_bubble_text_color', { length: 20 }),
  agentBubbleColor: varchar('agent_bubble_color', { length: 20 }),
  agentBubbleTextColor: varchar('agent_bubble_text_color', { length: 20 }),
}, (table) => [
  index('helpdesk_widget_settings_widget_id_idx').on(table.widgetId),
]);

export type HelpdeskWidgetSettings = typeof helpdeskWidgetSettings.$inferSelect;
export type NewHelpdeskWidgetSettings = typeof helpdeskWidgetSettings.$inferInsert;
