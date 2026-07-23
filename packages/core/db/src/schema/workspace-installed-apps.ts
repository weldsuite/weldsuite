import { pgTable, varchar, boolean, timestamp, jsonb, integer, unique } from 'drizzle-orm/pg-core';

// Workspace installed apps - tracks which apps are enabled for a workspace
// This is workspace-level, not user-level (unlike user_app_assignments)
export const workspaceInstalledApps = pgTable(
  'workspace_installed_apps',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    appCode: varchar('app_code', { length: 50 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    displayOrder: integer('display_order').default(0),

    // User-created apps (WeldApps): 'system' = first-party module,
    // 'user' = user-created app hosted in the /apps/{code} iframe host.
    appType: varchar('app_type', { length: 20 }).notNull().default('system'),
    // master DB user_apps.id when appType = 'user'
    userAppId: varchar('user_app_id', { length: 30 }),
    // Scopes the installing admin consented to (copy of the master install grant,
    // kept tenant-side so the platform can render them without a master query)
    grantedScopes: jsonb('granted_scopes').$type<string[]>(),

    // App-specific settings (JSON)
    settings: jsonb('settings').$type<Record<string, any>>(),

    // Installation metadata
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow(),
    installedBy: varchar('installed_by', { length: 255 }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('uq_workspace_installed_app').on(table.appCode),
  ]
);

export type WorkspaceInstalledApp = typeof workspaceInstalledApps.$inferSelect;
export type NewWorkspaceInstalledApp = typeof workspaceInstalledApps.$inferInsert;
