/**
 * Who sees a sidebar item: one permission key, or a list where any one of
 * them is enough (e.g. a dashboard that any of several read permissions opens).
 */
export type MenuPermission = string | readonly string[];

/** True when `permission` is unset, or `can` passes for it (or for any key in the list). */
export function menuPermissionAllows(
  permission: MenuPermission | undefined,
  can: (permission: string) => boolean,
): boolean {
  if (!permission) return true;
  if (typeof permission === 'string') return can(permission);
  return permission.some(can);
}
