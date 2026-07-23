/**
 * @weldsuite/permissions — useCan hook(s)
 *
 * Tiny ergonomic wrappers around `usePermissionsMaybe()` for the common case
 * of "do I have this permission?". Safe-deny outside the provider and while
 * permissions are still loading.
 *
 * @example
 * ```tsx
 * const canCreate = useCan('leads:create');
 * const canEditOrManage = useCanAny(['leads:update', 'leads:manage']);
 * ```
 */

import { usePermissionsMaybe } from './provider';

export function useCan(permission: string): boolean {
  const ctx = usePermissionsMaybe();
  if (!ctx || ctx.isLoading) return false;
  if (ctx.isOwner) return true;
  return ctx.can(permission);
}

export function useCanAny(permissions: string[]): boolean {
  const ctx = usePermissionsMaybe();
  if (!ctx || ctx.isLoading) return false;
  if (ctx.isOwner) return true;
  return ctx.canAny(...permissions);
}

export function useCanAll(permissions: string[]): boolean {
  const ctx = usePermissionsMaybe();
  if (!ctx || ctx.isLoading) return false;
  if (ctx.isOwner) return true;
  return ctx.canAll(...permissions);
}
