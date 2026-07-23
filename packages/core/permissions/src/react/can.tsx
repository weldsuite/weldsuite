/**
 * @weldsuite/permissions — Can component
 *
 * Hide-by-default permission wrapper. Renders children only if the user has
 * the required permission(s); otherwise renders `fallback` (defaults to null).
 *
 * Exactly one of `permission`, `any`, `all`, or `object` should be provided.
 * If multiple are passed, the component fails loudly in development
 * (`console.warn`) and treats the check as denied.
 *
 * @example
 * ```tsx
 * <Can permission="leads:create">
 *   <Button>Create lead</Button>
 * </Can>
 *
 * <Can any={['leads:update', 'leads:manage']} fallback={<span>Read-only</span>}>
 *   <EditForm />
 * </Can>
 *
 * <Can object="leads">
 *   <LeadsNavLink />
 * </Can>
 * ```
 */

import type { ReactNode } from 'react';
import { usePermissionsMaybe } from './provider';

export interface CanProps {
  /** Single permission key (object:action). Passes if the user has it. */
  permission?: string;
  /** Passes if user has ANY of these. */
  any?: string[];
  /** Passes if user has ALL of these. */
  all?: string[];
  /** Passes if user has any permission on this object key. */
  object?: string;
  /** Rendered when access denied. Defaults to null. */
  fallback?: ReactNode;
  children: ReactNode;
}

function countDefined(...values: unknown[]): number {
  return values.reduce<number>((acc, v) => acc + (v !== undefined ? 1 : 0), 0);
}

function isDev(): boolean {
  // Avoid relying on @types/node — read process.env defensively.
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  return proc?.env?.NODE_ENV !== 'production';
}

export function Can({
  permission,
  any,
  all,
  object,
  fallback = null,
  children,
}: CanProps): ReactNode {
  const ctx = usePermissionsMaybe();

  // No provider — safe-deny.
  if (!ctx) return fallback;

  // Loading — safe-deny.
  if (ctx.isLoading) return fallback;

  // Owner short-circuit.
  if (ctx.isOwner) return children;

  // Validate exclusivity in development. Multiple checks → deny.
  const provided = countDefined(permission, any, all, object);
  if (provided > 1) {
    if (isDev()) {
      // eslint-disable-next-line no-console
      console.warn(
        '[<Can>] Exactly one of `permission`, `any`, `all`, or `object` should be provided. Treating as denied.',
      );
    }
    return fallback;
  }

  let allowed = false;

  if (permission) {
    allowed = ctx.can(permission);
  } else if (any) {
    allowed = ctx.canAny(...any);
  } else if (all) {
    allowed = ctx.canAll(...all);
  } else if (object) {
    allowed = ctx.hasAnyObject([object]);
  } else {
    // No predicate — render children (consistent with PermissionGate's prior behavior).
    allowed = true;
  }

  return allowed ? children : fallback;
}
