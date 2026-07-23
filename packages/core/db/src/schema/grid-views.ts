import { pgTable, varchar, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

// Grid view settings - column visibility per user per grid
export const gridViews = pgTable(
  'grid_views',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    userId: varchar('user_id', { length: 255 }).notNull(),
    gridName: varchar('grid_name', { length: 100 }).notNull(),

    // Column visibility map: { columnId: boolean }
    columnVisibility: jsonb('column_visibility').$type<Record<string, boolean>>().notNull().default({}),

    // Column widths map: { columnId: number }
    columnWidths: jsonb('column_widths').$type<Record<string, number>>().notNull().default({}),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('grid_views_user_grid_idx').on(table.userId, table.gridName),
  ]
);

export type GridView = typeof gridViews.$inferSelect;
export type NewGridView = typeof gridViews.$inferInsert;
