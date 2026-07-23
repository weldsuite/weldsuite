/**
 * @weldsuite/permissions — PermissionGate component
 *
 * @deprecated Prefer `<Can>` from `@weldsuite/permissions/react`. PermissionGate
 * is now a thin compatibility wrapper kept for historical callers; its `app`
 * prop is the only behavior not directly mapped to `<Can>` (it expands a legacy
 * app prefix to its object keys via the migration map).
 *
 * @example
 * ```tsx
 * // Old:
 * <PermissionGate permission="leads:create"><Button /></PermissionGate>
 * // New:
 * <Can permission="leads:create"><Button /></Can>
 * ```
 */

import type { ReactNode } from 'react';
import { Can } from './can';
import { usePermissionsMaybe } from './provider';

export interface PermissionGateProps {
  /** Single permission to check */
  permission?: string;
  /** Check if user has ANY of these permissions */
  any?: string[];
  /** Check if user has ALL of these permissions */
  all?: string[];
  /**
   * Check if user has access to a legacy app prefix (e.g. 'weldcrm').
   * @deprecated Use `<Can object="...">` with the new object key instead.
   */
  app?: string;
  /** Rendered when permission check fails (defaults to null) */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * @deprecated Use `<Can>` instead.
 */
export function PermissionGate({
  permission,
  any,
  all,
  app,
  fallback = null,
  children,
}: PermissionGateProps): ReactNode {
  // Hook must always run unconditionally — only its result is used when `app`
  // is provided.
  const ctx = usePermissionsMaybe();

  if (app) {
    if (!ctx) return fallback;
    if (ctx.isLoading) return fallback;
    if (ctx.isOwner) return children;
    return ctx.hasApp(app) ? children : fallback;
  }

  return (
    <Can permission={permission} any={any} all={all} fallback={fallback}>
      {children}
    </Can>
  );
}
