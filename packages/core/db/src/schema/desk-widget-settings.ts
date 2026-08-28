import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export interface DeskWidgetBranding {
  primaryColor?: string;
  backgroundColor?: string;
  position?: 'right' | 'left';
}

export const deskWidgetSettings = pgTable(
  'desk_widget_settings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    widgetId: varchar('widget_id', { length: 40 }).notNull(),
    widgetName: varchar('widget_name', { length: 255 }),
    enabled: boolean('enabled').notNull().default(true),

    greeting: varchar('greeting', { length: 500 }),
    branding: jsonb('branding').$type<DeskWidgetBranding>(),
    allowedDomains: jsonb('allowed_domains').$type<string[]>(),
  },
  (table) => [
    uniqueIndex('desk_widget_settings_widget_id_idx').on(table.widgetId),
  ],
);

export type DeskWidgetSettings = typeof deskWidgetSettings.$inferSelect;
export type NewDeskWidgetSettings = typeof deskWidgetSettings.$inferInsert;
