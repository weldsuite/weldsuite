/**
 * @weldsuite/permissions — Type definitions
 *
 * Shared between server (Hono middleware) and client (React hooks).
 *
 * Permission key format is `object:action` (2 segments). The previous
 * `app:module:action` format has been collapsed: same-named modules across
 * apps now share a single object. See migration-map.ts for the full mapping.
 */

// ---------------------------------------------------------------------------
// Permission actions
// ---------------------------------------------------------------------------

export const PERMISSION_ACTIONS = ['read', 'create', 'update', 'delete', 'manage'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Permission catalog structure
// ---------------------------------------------------------------------------

export interface PermissionDefinition {
  /** e.g. "leads:read" */
  key: string;
  /** Human-readable label, e.g. "View leads" */
  label: string;
  description?: string;
}

export interface ObjectDefinition {
  /** Object key, e.g. "leads" */
  key: string;
  /** Human-readable label, e.g. "Leads" */
  label: string;
  permissions: PermissionDefinition[];
}

// ---------------------------------------------------------------------------
// System role definitions
// ---------------------------------------------------------------------------

export interface SystemRoleDefinition {
  name: string;
  description: string;
  isSystem: true;
  permissions: string[];
}

export type SystemRoleName = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

// ---------------------------------------------------------------------------
// Resolved permission context (used by both server middleware and React)
// ---------------------------------------------------------------------------

export interface ResolvedPermissions {
  /** Raw permission strings (may include wildcards) */
  permissions: string[];
  /** The member's workspace role name */
  role: string;
  /** Custom role ID if assigned */
  roleId: string | null;
  /** Whether the user is the workspace owner */
  isOwner: boolean;
}
