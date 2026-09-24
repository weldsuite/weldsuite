/**
 * Bridge between the ported v1 routes' coarse scopes and WeldSuite's real
 * permission catalog.
 *
 * The routes copied from external-api guard themselves with two verbs only —
 * `requireScope('leads:read')` and `requireScope('leads:write')` — because an
 * API key's scopes were coarse by design. The permission catalog
 * (`@weldsuite/permissions`) is finer: `read`, `create`, `update`, `delete`.
 *
 * Collapsing `write` onto all three would mean a user granted only
 * `leads:create` could delete leads through the MCP server — a privilege
 * escalation over what the same user can do in the UI. So the check is made
 * **method-aware**: the required permission is derived from the scope's object
 * plus the HTTP verb of the actual request, and `DELETE` always demands an
 * explicit `:delete` grant.
 */

import { hasAppPermission, type PermissionSubject } from '@weldsuite/permissions';

/** Actions that satisfy a request, by HTTP method. */
const ACTIONS_BY_METHOD: Record<string, readonly string[]> = {
  GET: ['read'],
  HEAD: ['read'],
  // POST covers both record creation and sub-resource action endpoints
  // (`/pages/:id/move`, `/:id/restore`, …), which are edits rather than
  // creations — so either grant satisfies it. `delete` deliberately does not.
  POST: ['create', 'update'],
  PATCH: ['update'],
  PUT: ['update'],
  DELETE: ['delete'],
};

/**
 * Route resources whose name differs from the permission-catalog object.
 *
 * `drive`/`workflows` follow `@weldsuite/permissions`' own migration map
 * (`welddrive` → `files`, `workflows` → `helpdesk-workflows`). The WeldFlow
 * artefacts (`goals`, `sprints`, `whiteboards`) have no catalog object of their
 * own and are governed by `projects`, and `members` is the catalog's `team`.
 */
const RESOURCE_ALIASES: Record<string, string> = {
  drive: 'files',
  members: 'team',
  workflows: 'helpdesk-workflows',
  'user-apps': 'weldapps',
  goals: 'projects',
  sprints: 'projects',
  whiteboards: 'projects',
};

/** Resolve a route scope's object to its permission-catalog object. */
function catalogObject(scope: string): string {
  const object = scope.split(':')[0] ?? '';
  return RESOURCE_ALIASES[object] ?? object;
}

/**
 * Scopes outside the coarse `read`/`write` pair (e.g. `user-apps:manage`) name
 * a catalog action directly, so they are checked literally rather than being
 * derived from the HTTP method.
 */
function literalVerb(verb: string | undefined): string | null {
  if (!verb || verb === 'read' || verb === 'write') return null;
  return verb;
}

/**
 * A caller's grants: the resolved permission list, optionally with the
 * member's explicit denies. A bare list is accepted for callers that only
 * hold grants.
 */
export type Grants = PermissionSubject | readonly string[];

function toSubject(grants: Grants): PermissionSubject {
  return isGrantList(grants) ? { permissions: [...grants] } : grants;
}

function isGrantList(grants: Grants): grants is readonly string[] {
  return Array.isArray(grants);
}

/**
 * Does this caller hold `key`?
 *
 * MCP requests have no app context (a tool isn't "in" WeldCRM or WeldDesk), so
 * an app-scoped key is allowed when ANY app grants it: `companies:read` passes
 * with `weldcrm:companies:read`. Wildcards and member denies behave exactly
 * as in app-api's requirePermission, via the shared @weldsuite/permissions
 * check.
 */
export function hasPermission(grants: Grants, key: string): boolean {
  return hasAppPermission(toSubject(grants), key, null);
}

/**
 * Enforcement check: may this caller perform `method` on `scope`?
 */
export function canPerform(grants: Grants, scope: string, method: string): boolean {
  const object = catalogObject(scope);
  if (!object) return false;

  const verb = literalVerb(scope.split(':')[1]);
  if (verb) return hasPermission(grants, `${object}:${verb}`);

  const actions = ACTIONS_BY_METHOD[method.toUpperCase()];
  if (!actions) return false;

  return actions.some((action) => hasPermission(grants, `${object}:${action}`));
}

/**
 * Visibility check used when registering tools.
 *
 * A tool is offered when the user could plausibly use it — for a `:write` tool
 * that means holding any mutating grant on the object. The precise gate is
 * still {@link canPerform} at call time, so a tool being listed never implies
 * it will succeed.
 */
export function canUseScope(grants: Grants, scope: string): boolean {
  const object = catalogObject(scope);
  if (!object) return false;

  const rawVerb = scope.split(':')[1];
  const verb = literalVerb(rawVerb);
  if (verb) return hasPermission(grants, `${object}:${verb}`);

  const actions = rawVerb === 'read' ? ['read'] : ['create', 'update', 'delete'];

  return actions.some((action) => hasPermission(grants, `${object}:${action}`));
}
