/**
 * Licence restrictions of a workspace for the MCP server. Copies of worker-kit's
 * `computeWorkspaceRestrictions`, `isReadOnlyRequestAllowed` and
 * `workspaceReadOnlyBody` (`packages/core/worker-kit/src/read-only.ts`): this
 * worker does not depend on worker-kit. Keep them in step; both have tests.
 *
 * A partner-managed workspace (docs/plans/reseller-licensing.md) may use the
 * apps in its licence and is read-only while its partner is suspended or its
 * licence is not active: tool calls that write are refused with
 * 403 WORKSPACE_READ_ONLY.
 *
 * A workspace whose tenant database is being moved (TASK-1150) is read-only too,
 * with reason `database_move`: its tool calls that write are refused with
 * 503 WORKSPACE_MOVING instead (the move rules are worker-kit's,
 * `@weldsuite/worker-kit/workspace-moving`).
 */

export type LicenceReadOnlyReason = 'partner_suspended' | 'licence_inactive';
export type ReadOnlyReason = LicenceReadOnlyReason | 'database_move';

export function workspaceRestrictions(input: {
  billingMode: string | null | undefined;
  licenceStatus: string | null | undefined;
  licenceApps: readonly string[] | null | undefined;
  partnerStatus: string | null | undefined;
  /** A database move in a write-blocking status; outranks a licence reason. */
  databaseMoveInProgress?: boolean | null;
}): { licensedApps: string[] | null; readOnly: boolean; readOnlyReason: ReadOnlyReason | null } {
  const restrictions = licenceRestrictions(input);
  if (input.databaseMoveInProgress) {
    return { ...restrictions, readOnly: true, readOnlyReason: 'database_move' };
  }
  return restrictions;
}

function licenceRestrictions(input: {
  billingMode: string | null | undefined;
  licenceStatus: string | null | undefined;
  licenceApps: readonly string[] | null | undefined;
  partnerStatus: string | null | undefined;
}): { licensedApps: string[] | null; readOnly: boolean; readOnlyReason: LicenceReadOnlyReason | null } {
  if (input.billingMode !== 'partner') return { licensedApps: null, readOnly: false, readOnlyReason: null };
  let readOnlyReason: LicenceReadOnlyReason | null = null;
  if (input.partnerStatus === 'suspended') readOnlyReason = 'partner_suspended';
  else if (input.licenceStatus !== 'active') readOnlyReason = 'licence_inactive';
  return { licensedApps: [...(input.licenceApps ?? [])], readOnly: readOnlyReason !== null, readOnlyReason };
}

/**
 * Reads always (GET, HEAD, OPTIONS); a write method only on `/v1/search`. No
 * "export" rule: a substring match let any write through, and no export
 * endpoint is a POST.
 */
export function isReadOnlyRequestAllowed(method: string, path: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
  return path === '/v1/search' || path.startsWith('/v1/search/');
}

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
