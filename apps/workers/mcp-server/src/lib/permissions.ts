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
 *
 * A few routes do not fit the verb (WeldReach's action routes, whose app
 * permission is `update` although they are POSTs): {@link ROUTE_PERMISSIONS}
 * pins those to exactly what the app itself requires.
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
 *
 * The `mail_*` scopes map onto the permissions WeldMail itself checks
 * (mail-api): mailbox setup — accounts, labels, folders — is `accounts`; the
 * mail in it — messages, drafts, attachments — is `messages`.
 */
const RESOURCE_ALIASES: Record<string, string> = {
  drive: 'files',
  members: 'team',
  workflows: 'helpdesk-workflows',
  'user-apps': 'weldapps',
  goals: 'projects',
  sprints: 'projects',
  whiteboards: 'projects',
  mail_accounts: 'accounts',
  mail_labels: 'accounts',
  mail_folders: 'accounts',
  mail_messages: 'messages',
  mail_drafts: 'messages',
  mail_attachments: 'messages',
};

/**
 * Routes whose permission is not the one their HTTP method implies, keyed by
 * `METHOD <registered route pattern>` (Hono's `routePath`, so IDs never matter).
 *
 * The verb rule is wrong for these in both directions, and each wrong answer is a
 * difference between MCP and the app for the same user:
 *
 * - a POST that is an *edit* (launch, pause, resume, enrol, list members) is
 *   satisfied by `create` under the verb rule, so a create-only grant could start
 *   sending; the app asks for `update`;
 * - a POST that *creates* is satisfied by `update` under the verb rule, while the
 *   app asks for `create`;
 * - a DELETE that is an edit (taking one prospect out of a campaign) asks for
 *   `delete` under the verb rule, while the app asks for `update`;
 * - `reach_settings` has only `read` and `update`: removing a suppression is
 *   `update` (the verb rule would ask for `delete`, which no one can hold), and
 *   adding one is `update` too (the verb rule's `create` does not exist, but a
 *   wildcard grant would still satisfy it and so slip past a member's deny on
 *   `update`).
 *
 * The source of truth is each route's `requirePermission(...)` in
 * `apps/workers/reach-api/src/routes`; `reach.test.ts` pins every non-GET reach
 * route to it, so a route added here without an entry fails the build.
 */
const ROUTE_PERMISSIONS: Readonly<Record<string, string>> = {
  'POST /v1/reach/campaigns': 'reach_campaigns:create',
  'POST /v1/reach/campaigns/:id/prospects': 'reach_campaigns:update',
  'DELETE /v1/reach/campaigns/:id/enrollments/:enrollmentId': 'reach_campaigns:update',
  'POST /v1/reach/campaigns/:id/launch': 'reach_campaigns:update',
  'POST /v1/reach/campaigns/:id/pause': 'reach_campaigns:update',
  'POST /v1/reach/campaigns/:id/resume': 'reach_campaigns:update',
  'POST /v1/reach/prospects': 'reach_prospects:create',
  'POST /v1/reach/prospects/import': 'reach_prospects:create',
  'POST /v1/reach/lists': 'reach_prospects:create',
  'POST /v1/reach/lists/:id/members': 'reach_prospects:update',
  'POST /v1/reach/lists/:id/members/remove': 'reach_prospects:update',
  'POST /v1/reach/suppressions': 'reach_settings:update',
  'DELETE /v1/reach/suppressions/:id': 'reach_settings:update',
};

/** The permission a route pins for itself, or undefined when the HTTP verb decides. */
export function routePermission(method: string, route: string | undefined): string | undefined {
  return route ? ROUTE_PERMISSIONS[`${method.toUpperCase()} ${route}`] : undefined;
}

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
 *
 * `route` is the registered pattern of the route being served
 * (`/v1/reach/campaigns/:id/launch`); a route that pins its own permission
 * (see {@link ROUTE_PERMISSIONS}) is checked against exactly that.
 */
export function canPerform(grants: Grants, scope: string, method: string, route?: string): boolean {
  const object = catalogObject(scope);
  if (!object) return false;

  const pinned = routePermission(method, route);
  if (pinned) return hasPermission(grants, pinned);

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
