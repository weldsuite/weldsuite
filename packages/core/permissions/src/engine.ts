/**
 * @weldsuite/permissions — Permission matching engine
 *
 * Zero-dependency module shared between server (Hono) and client (React).
 * Implements wildcard matching for the permission format: "object:action"
 *
 * Wildcard rules:
 *   "*"           → matches everything
 *   "leads:*"     → matches any action on `leads`
 *   "*:read"      → matches the `read` action on any object
 *   "leads:read"  → exact match only
 *
 * The matcher is segment-count agnostic — it walks segments generically — so
 * the legacy 3-segment keys (e.g. `weldcrm:leads:read`) still match correctly
 * for as long as they coexist in storage. After the data migration runs, only
 * 2-segment keys remain.
 */

/**
 * Check whether a single user permission string matches a required permission.
 *
 * @param userPerm  - A single permission the user holds (may contain wildcards)
 * @param required  - The permission being checked (never contains wildcards)
 */
function permissionMatches(userPerm: string, required: string): boolean {
  // Global wildcard
  if (userPerm === '*') return true;

  // Exact match (fast path)
  if (userPerm === required) return true;

  const userParts = userPerm.split(':');
  const reqParts = required.split(':');

  // Walk each segment
  for (let i = 0; i < userParts.length; i++) {
    const up = userParts[i];

    // Trailing wildcard: "leads:*" matches anything that started with "leads:"
    if (up === '*' && i === userParts.length - 1) {
      // All remaining required segments are accepted
      return true;
    }

    // No more required segments but user pattern continues → no match
    if (i >= reqParts.length) return false;

    // Wildcard segment in the middle: "*:read" — accept any value in this position
    if (up === '*') continue;

    // Exact segment match
    if (up !== reqParts[i]) return false;
  }

  // User pattern consumed. Match only if required pattern is also fully consumed.
  return userParts.length === reqParts.length;
}

/**
 * Check if a set of user permissions grants access for a required permission.
 */
export function hasPermission(userPermissions: string[], required: string): boolean {
  for (const perm of userPermissions) {
    if (permissionMatches(perm, required)) return true;
  }
  return false;
}

/**
 * Check if the user has ANY of the required permissions.
 */
export function hasAnyPermission(userPermissions: string[], required: string[]): boolean {
  for (const req of required) {
    if (hasPermission(userPermissions, req)) return true;
  }
  return false;
}

/**
 * Check if the user has ALL of the required permissions.
 */
export function hasAllPermissions(userPermissions: string[], required: string[]): boolean {
  for (const req of required) {
    if (!hasPermission(userPermissions, req)) return false;
  }
  return true;
}

/**
 * Check if the user has any permission on a given object (any action).
 *
 * Useful for sidebar / app-section gating: "does the user have any access to
 * leads at all?".
 *
 * @param userPermissions - The user's permission set
 * @param objectKey       - e.g. "leads"
 */
export function hasObjectAccess(userPermissions: string[], objectKey: string): boolean {
  // Global wildcard
  if (userPermissions.includes('*')) return true;

  const prefix = `${objectKey}:`;
  const fullWildcard = `${objectKey}:*`;

  for (const perm of userPermissions) {
    if (perm === fullWildcard) return true;
    if (perm.startsWith(prefix)) return true;
    // Cross-segment wildcard like '*:read' also grants object access
    if (perm.startsWith('*:')) return true;
  }
  return false;
}

/**
 * Check if the user has any permission on at least one of the given objects.
 *
 * Useful for app-section gating: "does the user have access to anything in the
 * CRM group?".
 */
export function hasAnyObjectAccess(userPermissions: string[], objectKeys: string[]): boolean {
  if (userPermissions.includes('*')) return true;
  for (const key of objectKeys) {
    if (hasObjectAccess(userPermissions, key)) return true;
  }
  return false;
}

/**
 * Expand wildcard permissions against a full catalog of permission keys.
 * Returns the full set of concrete permission keys the user holds.
 *
 * Useful for permission editor UI: showing which exact permissions are granted.
 */
export function expandWildcards(userPermissions: string[], catalogKeys: string[]): string[] {
  const result = new Set<string>();

  for (const key of catalogKeys) {
    if (hasPermission(userPermissions, key)) {
      result.add(key);
    }
  }

  return [...result];
}
