import { z } from 'zod';

// ============================================================================
// Roles — custom workspace roles with permissions AND app grants.
//
// Backed by the tenant `roles` table. Permission prefix: `roles:*`.
//
// `apps` is the set of app codes a role grants. A member holding the role
// gets those apps automatically — resolved live at read time in app-api's
// dashboard installed-apps route (union of role apps + per-user assignments),
// so editing a role's apps instantly updates every member with that role.
// ============================================================================

export const createRoleSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  apps: z.array(z.string()).optional(),
  copyFromRoleId: z.string().optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  apps: z.array(z.string()).optional(),
});

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

// ----------------------------------------------------------------------------
// Response shapes (shared client + server)
// ----------------------------------------------------------------------------

export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  isSystemRole: boolean;
  canDelete: boolean;
  canModify: boolean;
  memberCount: number;
  permissions: string[];
  apps: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RoleDetail extends RoleSummary {}

export interface InstallableApp {
  appCode: string;
  appName: string;
}

// The same shapes as Zod schemas, for checking responses (the conformance
// suite validates the Rust backend's answers with them).

export const roleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystemRole: z.boolean(),
  canDelete: z.boolean(),
  canModify: z.boolean(),
  memberCount: z.number().int(),
  permissions: z.array(z.string()),
  apps: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** GET /api/roles: the roles, not paginated. */
export const roleListSchema = z.array(roleSummarySchema);

export const installableAppSchema = z.object({
  appCode: z.string(),
  appName: z.string(),
});

/** GET /api/roles/installable-apps. */
export const installableAppListSchema = z.array(installableAppSchema);

/** One permission of the role editor's catalog. */
export const permissionCatalogEntrySchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().optional(),
  action: z.string(),
  isGranted: z.boolean(),
});

/** One object of the catalog and its permissions. */
export const permissionCatalogObjectSchema = z.object({
  object: z.string(),
  objectName: z.string(),
  permissions: z.array(permissionCatalogEntrySchema),
});

/** GET /api/roles/permission-catalog. */
export const permissionCatalogSchema = z.object({
  objects: z.array(permissionCatalogObjectSchema),
  customObjects: z.array(permissionCatalogObjectSchema),
  apps: z.array(
    z.object({
      app: z.string(),
      appName: z.string(),
      objects: z.array(permissionCatalogObjectSchema),
    }),
  ),
  workspace: z.array(permissionCatalogObjectSchema),
});

export type PermissionCatalog = z.infer<typeof permissionCatalogSchema>;
