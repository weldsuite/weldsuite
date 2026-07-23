/**
 * RBAC Types
 * Role-Based Access Control types for permissions and app assignments
 */

// ============================================================================
// Role Types
// ============================================================================

export interface Role {
  id: string;
  name: string;
  description?: string;
  isSystemRole: boolean;
  canDelete: boolean;
  canModify: boolean;
  memberCount: number;
  /** Permission keys granted by this role. */
  permissions?: string[];
  /** App codes this role grants to its members. */
  apps?: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface RoleDetail extends Role {
  permissions: string[];
  apps: string[];
  groupedPermissions?: ObjectPermissions[];
}

/** A workspace-installed app that a role can grant. */
export interface InstallableApp {
  appCode: string;
  appName: string;
}

export interface ObjectPermissions {
  object: string;
  objectName: string;
  permissions: Permission[];
}

export interface Permission {
  code: string;
  name: string;
  description?: string;
  action: string;
  isGranted: boolean;
}

// ============================================================================
// Permission Catalog Types
// ============================================================================

export interface PermissionCatalogItem {
  code: string;
  name: string;
  description?: string;
  object: string;
  objectName: string;
  action: string;
}

export interface PermissionCatalog {
  objects: ObjectPermissions[];
}

// ============================================================================
// App Assignment Types
// ============================================================================

export interface AppInfo {
  code: string;
  name: string;
  description?: string;
  icon?: string;
}

export interface MemberAppAssignment {
  appCode: string;
  appName: string;
  appIcon?: string;
  isAssigned: boolean;
  assignedAt?: string;
  assignedBy?: string;
}

// ============================================================================
// Request Types
// ============================================================================

export interface CreateRoleRequest {
  name: string;
  description?: string;
  copyFromRoleId?: string;
  permissions?: string[];
}

export interface UpdateRoleRequest {
  name?: string;
  description?: string;
  permissions?: string[];
}

export interface UpdateRolePermissionsRequest {
  permissions: string[];
}

export interface UpdateMemberRoleRequest {
  systemRole?: string;
  role?: string;
  roleId?: string;
}

export interface UpdateMemberAppsRequest {
  appCodes: string[];
}

export interface ToggleAppAccessRequest {
  appCode: string;
  granted: boolean;
}

// ============================================================================
// Response Types
// ============================================================================

export interface SuccessResponse {
  success: boolean;
  message: string;
}

export interface PermissionCheckResult {
  [permissionCode: string]: boolean;
}

// ============================================================================
// System Role Constants
// ============================================================================

const SystemRoles = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
  VIEWER: 'VIEWER',
} as const;

type SystemRole = keyof typeof SystemRoles;

// ============================================================================
// Permission Actions
// ============================================================================

const PermissionActions = {
  READ: 'read',
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  MANAGE: 'manage',
  INVITE: 'invite',
  ASSIGN: 'assign',
  CONVERT: 'convert',
  REFUND: 'refund',
  SEND: 'send',
  PUBLISH: 'publish',
} as const;

type PermissionAction = (typeof PermissionActions)[keyof typeof PermissionActions];
