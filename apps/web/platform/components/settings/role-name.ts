/**
 * Role-name rules shared by the create dialog and the role editor. The server
 * (app-api `/api/roles`) enforces the same rules; these let the form show the
 * error inline before submitting, and map the server's answer when it still
 * rejects the name (a role created meanwhile).
 */

import { isApiError } from '@weldsuite/api-client/client';

export type RoleNameProblem = 'reserved' | 'duplicate';

/** System role names, which a custom role may never take. */
const RESERVED = new Set(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);

const normalise = (name: string) => name.trim().toUpperCase();

/**
 * Why `name` can't be used, or null. `roles` are the workspace's current
 * roles; `exceptRoleId` is the role being renamed.
 */
export function roleNameProblem(
  name: string,
  roles: ReadonlyArray<{ id: string; name: string }>,
  exceptRoleId?: string,
): RoleNameProblem | null {
  const wanted = normalise(name);
  if (!wanted) return null;
  if (RESERVED.has(wanted)) return 'reserved';
  return roles.some((r) => r.id !== exceptRoleId && normalise(r.name) === wanted) ? 'duplicate' : null;
}

/** The name problem a failed create/update request reports, if any. */
export function roleNameProblemFromError(err: unknown): RoleNameProblem | null {
  if (!isApiError(err)) return null;
  const reason = (err.body as { error?: { details?: { reason?: unknown } } } | undefined)?.error?.details?.reason;
  if (reason === 'reserved' || reason === 'duplicate') return reason;
  if (err.status === 409) return 'duplicate';
  return null;
}

/** Translation key for a name problem (takes `{name}`). */
export function roleNameProblemKey(problem: RoleNameProblem): string {
  return `settings.roles.nameErrors.${problem}`;
}
