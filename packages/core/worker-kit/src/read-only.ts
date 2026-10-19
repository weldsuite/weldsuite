/**
 * Read-only workspaces (docs/plans/reseller-licensing.md).
 *
 * A partner-managed workspace turns read-only when its partner is suspended
 * (unpaid statement) or its licence is not active (suspended or ended). Members
 * can still sign in, view and export; every write is refused with
 * `403 WORKSPACE_READ_ONLY`.
 *
 * `computeWorkspaceRestrictions` is evaluated once, when the workspace context
 * is read from the master DB on a cache miss; `licenceGate()` enforces it per
 * request with `isReadOnlyRequestAllowed`.
 *
 * A workspace whose tenant database is being moved (TASK-1150, ADR DATA-016) is
 * read-only too, for the other reason: `database_move`. It is not a licence
 * matter, so `licenceGate()` answers it with a retryable
 * `503 WORKSPACE_MOVING` (see ./workspace-moving.ts), not the 403 below, with
 * the same exceptions (`isReadOnlyRequestAllowed`: reads, search, the user-level
 * paths). Data safety does not depend on the gate: writes that land during the
 * drain are copied, and once the move locks the database it refuses writes
 * itself (those surface as 25006 / 28P01, which `createModuleApi` also answers
 * with 503 WORKSPACE_MOVING).
 *
 * external-api and mcp-server do not use this file, so each carries a small
 * copy of `computeWorkspaceRestrictions`, `isReadOnlyRequestAllowed` and
 * `workspaceReadOnlyBody`
 * (`apps/workers/external-api/src/middleware/licence.ts`,
 * `apps/workers/mcp-server/src/lib/read-only.ts`), each with its own test.
 * Change the rule here and in both copies together. The database-move rules
 * are not copied: both import them (the 503 answer, the request rule, the error
 * classification and the master-query fragment) from
 * `@weldsuite/worker-kit/workspace-moving`.
 */

/** Why a workspace's licence makes it read-only (answered with 403 WORKSPACE_READ_ONLY). */
export type LicenceReadOnlyReason = 'partner_suspended' | 'licence_inactive';

/**
 * Why a workspace may only be read: a licence reason, or `database_move` while
 * its tenant database is being moved (answered with 503 WORKSPACE_MOVING).
 */
export type ReadOnlyReason = LicenceReadOnlyReason | 'database_move';

/** What a workspace's billing mode, licence and partner say it may do. */
export interface WorkspaceRestrictions {
  /** App codes the workspace is licensed for; null = unrestricted. */
  licensedApps: string[] | null;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
}

export interface WorkspaceRestrictionInput {
  billingMode: string | null | undefined;
  /** The workspace's `workspace_licences` row (partner workspaces only). */
  licence: { status: string; allowedApps: readonly string[] | null } | null | undefined;
  /** `partners.status` of the workspace's partner. */
  partnerStatus: string | null | undefined;
  /**
   * The workspace has a database move in a write-blocking status
   * (`WRITE_BLOCKING_DATABASE_MOVE_STATUSES`). Applies to every workspace,
   * direct or partner-managed.
   */
  databaseMoveInProgress?: boolean | null;
}

export const UNRESTRICTED: WorkspaceRestrictions = Object.freeze({
  licensedApps: null,
  readOnly: false,
  readOnlyReason: null,
}) as WorkspaceRestrictions;

/**
 * Direct workspaces are unrestricted. A partner workspace may use the apps in
 * its licence (none, i.e. core only, when it has no licence row) and is
 * read-only when its partner is suspended or its licence is not active. A
 * partner workspace without a licence row is an inconsistent state and fails
 * closed.
 */
export function computeWorkspaceRestrictions(input: WorkspaceRestrictionInput): WorkspaceRestrictions {
  const restrictions = computeLicenceRestrictions(input);
  // A move outranks a licence reason: while it runs the answer is "try again",
  // and once it ends the cache is rebuilt and the licence reason is back.
  if (input.databaseMoveInProgress) {
    return { ...restrictions, readOnly: true, readOnlyReason: 'database_move' };
  }
  return restrictions;
}

function computeLicenceRestrictions(input: WorkspaceRestrictionInput): WorkspaceRestrictions {
  if (input.billingMode !== 'partner') return { ...UNRESTRICTED };

  const licensedApps = [...(input.licence?.allowedApps ?? [])];
  let readOnlyReason: LicenceReadOnlyReason | null = null;
  if (input.partnerStatus === 'suspended') readOnlyReason = 'partner_suspended';
  else if (input.licence?.status !== 'active') readOnlyReason = 'licence_inactive';

  return { licensedApps, readOnly: readOnlyReason !== null, readOnlyReason };
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** User-level core paths: they change the caller's own settings, never workspace data. */
const READ_ONLY_ALLOWED_PREFIXES = [
  '/api/search',
  '/api/me',
  '/api/user-preferences',
  '/api/notification-preferences',
  '/api/push-tokens',
] as const;

/**
 * May this request run in a read-only workspace? Reads always (GET, HEAD,
 * OPTIONS); a write method only on the explicit side-effect-free paths below
 * (search, the user-level core paths). Prefixes match on a path-segment
 * boundary, so `/api/me` does not open `/api/members`.
 *
 * There is deliberately no rule for "export": every export endpoint in the
 * repo is a GET (books `accounting-exports`, tax-return export, WeldPass
 * secrets export), so it passes as a read. A substring rule such as
 * `path.includes('/export')` let any write through (`POST
 * /api/weldagent/templates/export` creates a template row). If a POST export
 * that writes nothing is ever added, list its exact path here.
 */
export function isReadOnlyRequestAllowed(method: string, path: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return true;
  return READ_ONLY_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** The 403 body every read-only gate returns, so all workers answer alike. */
export function workspaceReadOnlyBody(reason: LicenceReadOnlyReason | null | undefined) {
  const resolved: LicenceReadOnlyReason = reason ?? 'licence_inactive';
  return {
    error: {
      code: 'WORKSPACE_READ_ONLY',
      message:
        resolved === 'partner_suspended'
          ? 'This workspace is read-only because the account that manages it is suspended. You can view and export your data.'
          : 'This workspace is read-only because its licence is not active. You can view and export your data.',
      details: { reason: resolved },
    },
  } as const;
}
