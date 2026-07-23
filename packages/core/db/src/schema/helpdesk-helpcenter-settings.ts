import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export interface HelpcenterSocialLinks {
  twitter?: string;
  facebook?: string;
  linkedin?: string;
  github?: string;
  youtube?: string;
  [key: string]: string | undefined;
}

export const helpcenterSettings = pgTable('helpcenter_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Enable/disable
  isEnabled: integer('is_enabled').default(0),

  // Branding
  siteName: varchar('site_name', { length: 255 }),
  logo: varchar('logo', { length: 500 }),
  logoDark: varchar('logo_dark', { length: 500 }),
  favicon: varchar('favicon', { length: 500 }),
  primaryColor: varchar('primary_color', { length: 20 }),
  accentColor: varchar('accent_color', { length: 20 }),

  // Hero
  heroTitle: text('hero_title'),
  heroSubtitle: text('hero_subtitle'),

  // Display options
  showSearch: integer('show_search').default(1),
  showCategories: integer('show_categories').default(1),

  // SEO
  metaTitle: varchar('meta_title', { length: 255 }),
  metaDescription: text('meta_description'),
  ogImage: varchar('og_image', { length: 500 }),

  // Footer & social
  footerText: text('footer_text'),
  socialLinks: jsonb('social_links').$type<HelpcenterSocialLinks>(),

  // Advanced
  customCss: text('custom_css'),
  googleAnalyticsId: varchar('google_analytics_id', { length: 50 }),

  // Domains (denormalized for quick access)
  defaultSubdomain: varchar('default_subdomain', { length: 255 }),
  customDomain: varchar('custom_domain', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('helpcenter_settings_is_enabled_idx').on(table.isEnabled),
]);

export type HelpcenterSettings = typeof helpcenterSettings.$inferSelect;
export type NewHelpcenterSettings = typeof helpcenterSettings.$inferInsert;
