interface JoinableInvitation {
  publicOrganizationData: { id: string };
}

/**
 * The pending invitation an invite link is for: the one into `orgId` when the
 * link names a workspace, else (links sent before it did) the first pending one.
 */
export function pickInvitation<T extends JoinableInvitation>(
  invitations: readonly T[] | undefined,
  orgId: string | undefined,
): T | undefined {
  if (!invitations?.length) return undefined;
  if (orgId) return invitations.find((inv) => inv.publicOrganizationData.id === orgId);
  return invitations[0];
}
