/**
 * @weldsuite/permissions — React permission provider
 *
 * Provides permission context to the React tree. The platform app fetches
 * permissions via its own API client / TanStack Query and passes them here.
 * This keeps the package free of API/query deps.
 */

import { createContext, useContext, useMemo } from 'react';
import { hasPermission, hasAnyPermission, hasAllPermissions, hasAnyObjectAccess } from '../engine';
import { APP_TO_OBJECTS } from '../migration-map';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PermissionContextValue {
  /** Raw permission strings (may include wildcards like '*' or 'weldcrm:*') */
  permissions: string[];
  /** Whether permissions are still loading from the API */
  isLoading: boolean;
  /** The user's workspace role (OWNER, ADMIN, MEMBER, VIEWER, or custom) */
  role: string;
  /** Whether the user is the workspace owner */
  isOwner: boolean;
  /** Check a single permission */
  can: (permission: string) => boolean;
  /** Check if user has ANY of the listed permissions */
  canAny: (...permissions: string[]) => boolean;
  /** Check if user has ALL of the listed permissions */
  canAll: (...permissions: string[]) => boolean;
  /**
   * Check if user has any access to an app (e.g. 'weldcrm').
   *
   * @deprecated Use `hasAnyObject(objectKeys)` instead. This shim maps legacy
   * app prefixes to the object keys they used to contain (via APP_TO_OBJECTS).
   */
  hasApp: (appPrefix: string) => boolean;
  /** Check if user has any permission on any of the given objects */
  hasAnyObject: (objectKeys: string[]) => boolean;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface PermissionProviderProps {
  /** Resolved permission strings from the API */
  permissions: string[];
  /** Whether permissions are still loading */
  isLoading?: boolean;
  /** The user's workspace role */
  role?: string;
  children: React.ReactNode;
}

export function PermissionProvider({
  permissions,
  isLoading = false,
  role = '',
  children,
}: PermissionProviderProps) {
  const value = useMemo<PermissionContextValue>(() => {
    const isOwner = role === 'OWNER' || permissions.includes('*');

    return {
      permissions,
      isLoading,
      role,
      isOwner,
      can: (perm: string) => {
        // While loading, assume no access (safe default)
        if (isLoading) return false;
        return hasPermission(permissions, perm);
      },
      canAny: (...perms: string[]) => {
        if (isLoading) return false;
        return hasAnyPermission(permissions, perms);
      },
      canAll: (...perms: string[]) => {
        if (isLoading) return false;
        return hasAllPermissions(permissions, perms);
      },
      hasApp: (appPrefix: string) => {
        if (isLoading) return false;
        const objects = APP_TO_OBJECTS[appPrefix] ?? [];
        return hasAnyObjectAccess(permissions, objects);
      },
      hasAnyObject: (objectKeys: string[]) => {
        if (isLoading) return false;
        return hasAnyObjectAccess(permissions, objectKeys);
      },
    };
  }, [permissions, isLoading, role]);

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access the permission context. Must be used within <PermissionProvider>.
 *
 * @example
 * ```tsx
 * const { can, canAny, isOwner, hasApp } = usePermissions();
 *
 * if (can('weldcrm:leads:create')) { ... }
 * if (hasApp('weldcrm')) { ... }
 * ```
 */
export function usePermissions(): PermissionContextValue {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error('usePermissions must be used within a <PermissionProvider>');
  }
  return ctx;
}

/**
 * Like usePermissions() but returns null instead of throwing when outside provider.
 * Useful for components that may render before the provider mounts.
 */
export function usePermissionsMaybe(): PermissionContextValue | null {
  return useContext(PermissionContext);
}
