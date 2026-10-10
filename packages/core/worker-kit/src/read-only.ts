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
 * external-api and mcp-server do not depend on worker-kit, so each carries a
 * small copy of `isReadOnlyRequestAllowed` and `workspaceReadOnlyBody`
 * (`apps/workers/external-api/src/middleware/licence.ts`,
 * `apps/workers/mcp-server/src/lib/read-only.ts`), each with its own test.
 * Change the rule here and in both copies together.
 */

export type ReadOnlyReason = 'partner_suspended' | 'licence_inactive';

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
  if (input.billingMode !== 'partner') return { ...UNRESTRICTED };

  const licensedApps = [...(input.licence?.allowedApps ?? [])];
  let readOnlyReason: ReadOnlyReason | null = null;
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
 * May this request run in a read-only workspace? Reads always; writes only on
 * read-style POSTs (search, anything under `/export`) and the user-level core
 * paths. Prefixes match on a path-segment boundary, so `/api/me` does not
 * open `/api/members`.
 */
export function isReadOnlyRequestAllowed(method: string, path: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return true;
  if (path.includes('/export')) return true;
  return READ_ONLY_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** The 403 body every read-only gate returns, so all workers answer alike. */
export function workspaceReadOnlyBody(reason: ReadOnlyReason | null | undefined) {
  const resolved: ReadOnlyReason = reason ?? 'licence_inactive';
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
