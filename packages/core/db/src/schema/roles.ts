import { pgTable, varchar, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';

// Roles - defines custom roles with permissions
export const roles = pgTable(
  'roles',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    // Role info
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),

    // System role flag (OWNER, ADMIN, MEMBER, VIEWER are system roles)
    isSystem: boolean('is_system').notNull().default(false),

    // Permissions assigned to this role
    permissions: jsonb('permissions').$type<string[]>().default([]),

    // App codes granted by this role. When a member holds this role they get
    // access to these apps automatically (live-derived at read time — see
    // app-api dashboard installed-apps), without per-user app assignments.
    apps: jsonb('apps').$type<string[]>().default([]),

    // Color for UI display
    color: varchar('color', { length: 20 }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  }
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

// ---------------------------------------------------------------------------
// Re-exports from @weldsuite/permissions (single source of truth)
//
// The permission catalog, system roles, and all related types now live in
// the shared @weldsuite/permissions package. These re-exports maintain
// backwards compatibility for existing imports.
// ---------------------------------------------------------------------------

export {
  PERMISSION_ACTIONS,
  type PermissionAction,
} from '@weldsuite/permissions/types';

export type {
  PermissionDefinition,
  ObjectDefinition,
} from '@weldsuite/permissions/types';

export {
  PERMISSION_CATALOG_OBJECTS,
  PERMISSION_CATALOG,
  SYSTEM_ROLES,
  getAllPermissionKeys,
} from '@weldsuite/permissions/catalog';
