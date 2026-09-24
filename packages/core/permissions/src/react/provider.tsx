/**
 * @weldsuite/permissions — React permission provider
 *
 * Provides permission context to the React tree. The platform app fetches
 * permissions via its own API client / TanStack Query and passes them here.
 * This keeps the package free of API/query deps.
 *
 * Checks are app-aware: `can('companies:read')` is evaluated as
 * `<app>:companies:read` for the provider's current `app` (the module the
 * user is in), exactly like the server's requirePermission. Wrap a subtree in
 * <AppPermissionScope app="…"> to evaluate it against another app, and pass a
 * fully qualified key (`weldbooks:invoices:read`) for a one-off cross-app
 * check. Member denies are honoured.
 */

import { createContext, useContext, useMemo } from 'react';
import { checkAppPermission, type PermissionSubject } from '../app-scope';
import { hasAnyObjectAccessInApp } from '../app-catalog';
import { getPermissionApp, normalizeAppCode } from '../apps';
import { APP_TO_OBJECTS } from '../migration-map';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PermissionContextValue {
  /** Raw permission strings (may include wildcards like '*' or 'weldcrm:*') */
  permissions: string[];
  /** Explicit per-member denies (may include wildcards) */
  denies: string[];
  /** Whether permissions are still loading from the API */
  isLoading: boolean;
  /** The user's workspace role (OWNER, ADMIN, MEMBER, VIEWER, or custom) */
  role: string;
  /** Whether the user is the workspace owner */
  isOwner: boolean;
  /** Canonical code of the app checks run against, or null (any app). */
  app: string | null;
  /** Check a single permission in the current app */
  can: (permission: string) => boolean;
  /** Check if user has ANY of the listed permissions in the current app */
  canAny: (...permissions: string[]) => boolean;
  /** Check if user has ALL of the listed permissions in the current app */
  canAll: (...permissions: string[]) => boolean;
  /**
   * Check if user has any access to an app (e.g. 'weldcrm').
   *
   * @deprecated Use `hasAnyObject(objectKeys, app)` instead.
   */
  hasApp: (appPrefix: string) => boolean;
  /**
   * Check if user has any permission on any of the given objects, in `app`
   * (defaults to the current app).
   */
  hasAnyObject: (objectKeys: string[], app?: string | null) => boolean;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

function buildValue(
  subject: PermissionSubject,
  isLoading: boolean,
  role: string,
  app: string | null,
): PermissionContextValue {
  const { permissions } = subject;
  const denies = subject.denies ?? [];
  const isOwner = role === 'OWNER' || permissions.includes('*');
  const allowed = (perm: string) => checkAppPermission(subject, perm, app).allowed;

  return {
    permissions,
    denies,
    isLoading,
    role,
    isOwner,
    app,
    // While loading, assume no access (safe default)
    can: (perm) => !isLoading && allowed(perm),
    canAny: (...perms) => !isLoading && perms.some(allowed),
    canAll: (...perms) => !isLoading && perms.every(allowed),
    hasApp: (appPrefix) => {
      if (isLoading) return false;
      const code = normalizeAppCode(appPrefix);
      const objects = (code && getPermissionApp(code)?.objects) || APP_TO_OBJECTS[appPrefix] || [];
      return hasAnyObjectAccessInApp(subject, objects, code);
    },
    hasAnyObject: (objectKeys, targetApp = app) => {
      if (isLoading) return false;
      return hasAnyObjectAccessInApp(subject, objectKeys, targetApp ? normalizeAppCode(targetApp) : null);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface PermissionProviderProps {
  /** Resolved permission strings from the API */
  permissions: string[];
  /** Explicit per-member denies from the API */
  denies?: string[];
  /** Whether permissions are still loading */
  isLoading?: boolean;
  /** The user's workspace role */
  role?: string;
  /**
   * The app checks run against (code or alias, e.g. the current module).
   * Omit or null for "allowed in any app".
   */
  app?: string | null;
  children: React.ReactNode;
}

export function PermissionProvider({
  permissions,
  denies,
  isLoading = false,
  role = '',
  app = null,
  children,
}: PermissionProviderProps) {
  const appCode = app ? normalizeAppCode(app) : null;
  const value = useMemo(
    () => buildValue({ permissions, denies: denies ?? [] }, isLoading, role, appCode),
    [permissions, denies, isLoading, role, appCode],
  );

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

/**
 * Evaluate a subtree's permission checks against a different app than the
 * one the user is in — e.g. a WeldBooks invoice panel opened from WeldCRM.
 * Must be rendered inside a <PermissionProvider>.
 */
export function AppPermissionScope({ app, children }: { app: string | null; children: React.ReactNode }) {
  const parent = useContext(PermissionContext);
  const appCode = app ? normalizeAppCode(app) : null;
  const value = useMemo(
    () =>
      parent
        ? buildValue({ permissions: parent.permissions, denies: parent.denies }, parent.isLoading, parent.role, appCode)
        : null,
    [parent, appCode],
  );
  if (!value) return <>{children}</>;
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access the permission context. Must be used within <PermissionProvider>.
 *
 * @example
 * ```tsx
 * const { can, canAny, isOwner, hasAnyObject } = usePermissions();
 *
 * if (can('leads:create')) { ... }        // in the current app
 * if (can('weldbooks:invoices:read')) { ... } // explicitly in WeldBooks
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
