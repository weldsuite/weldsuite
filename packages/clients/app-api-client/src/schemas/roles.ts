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
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  apps: z.array(z.string()).optional(),
  copyFromRoleId: z.string().optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
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
