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
 */

export type ReadOnlyReason = 'partner_suspended' | 'licence_inactive';

export function workspaceRestrictions(input: {
  billingMode: string | null | undefined;
  licenceStatus: string | null | undefined;
  licenceApps: readonly string[] | null | undefined;
  partnerStatus: string | null | undefined;
}): { licensedApps: string[] | null; readOnly: boolean; readOnlyReason: ReadOnlyReason | null } {
  if (input.billingMode !== 'partner') return { licensedApps: null, readOnly: false, readOnlyReason: null };
  const readOnlyReason: ReadOnlyReason | null =
    input.partnerStatus === 'suspended'
      ? 'partner_suspended'
      : input.licenceStatus !== 'active'
        ? 'licence_inactive'
        : null;
  return { licensedApps: [...(input.licenceApps ?? [])], readOnly: readOnlyReason !== null, readOnlyReason };
}

/** Reads always; writes only on read-style POSTs (anything under `/export`, `/v1/search`). */
export function isReadOnlyRequestAllowed(method: string, path: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
  if (path.includes('/export')) return true;
  return path === '/v1/search' || path.startsWith('/v1/search/');
}

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
