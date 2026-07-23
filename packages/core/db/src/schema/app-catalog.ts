import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// App catalog table - master database (system-wide app definitions)
export const appCatalog = pgTable('app_catalog', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Basic identification
  code: varchar('code', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description').notNull(), // Short description for listing
  icon: varchar('icon', { length: 50 }).notNull(), // Emoji or Lucide icon name
  category: varchar('category', { length: 50 }).notNull(),
  path: varchar('path', { length: 100 }).notNull(), // URL path like /commerce

  // Detail page content
  overview: text('overview'), // Long description for detail page
  features: jsonb('features').$type<string[]>().default([]), // Feature list
  howItWorks: jsonb('how_it_works').$type<{ title: string; description: string }[]>().default([]),

  // Status and visibility
  isActive: boolean('is_active').notNull().default(true),
  isPublished: boolean('is_published').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),

  // Metadata
  version: varchar('version', { length: 20 }).default('1.0.0'),
  provider: varchar('provider', { length: 100 }).default('WeldSuite'),
  verified: boolean('verified').notNull().default(false),
  releasedAt: timestamp('released_at', { withTimezone: true }),

  // Resource links (shown on the detail page sidebar)
  websiteUrl: text('website_url'),
  documentationUrl: text('documentation_url'),
  contactUrl: text('contact_url'),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('app_catalog_code_idx').on(table.code),
  index('app_catalog_category_idx').on(table.category),
  index('app_catalog_is_active_idx').on(table.isActive),
  index('app_catalog_is_published_idx').on(table.isPublished),
  index('app_catalog_sort_order_idx').on(table.sortOrder),
]);

// App screenshots table - stores screenshot metadata
export const appScreenshots = pgTable('app_screenshots', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Reference to app
  appId: varchar('app_id', { length: 30 }).notNull().references(() => appCatalog.id, { onDelete: 'cascade' }),

  // File info (stored in R2)
  fileKey: varchar('file_key', { length: 500 }).notNull(), // R2 storage key
  fileName: varchar('file_name', { length: 255 }).notNull(),
  fileSize: integer('file_size').notNull(),
  mimeType: varchar('mime_type', { length: 100 }).notNull(),
  url: text('url').notNull(), // Public URL

  // Display options
  sortOrder: integer('sort_order').notNull().default(0),
  caption: varchar('caption', { length: 255 }),
  altText: varchar('alt_text', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('app_screenshots_app_id_idx').on(table.appId),
  index('app_screenshots_sort_order_idx').on(table.sortOrder),
]);

// Type exports
export type AppCatalogEntry = typeof appCatalog.$inferSelect;
export type NewAppCatalogEntry = typeof appCatalog.$inferInsert;
export type AppScreenshot = typeof appScreenshots.$inferSelect;
export type NewAppScreenshot = typeof appScreenshots.$inferInsert;

// Category constants for UI
export const APP_CATEGORIES = [
  'Sales & Marketing',
  'Finance',
  'Operations',
  'Productivity',
  'Customer Support',
  'Communication',
  'Infrastructure',
  'Automations',
  'Integrations',
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number];
