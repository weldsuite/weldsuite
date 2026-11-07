import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { WELDREACH_APP_CODE } from '@/lib/app-access';
import { getAppAccessById, getReachUsage } from '@/lib/app-access-data';
import { getWorkspaceById } from '@/lib/workspaces-data';

/** Everything the access request page shows; null when there is no such request. */
export async function loadAccessRequestPage(input: { id: string }) {
  const identity = await requireAdmin();

  const access = await getAppAccessById(input.id);
  if (!access) return null;

  const workspace = await getWorkspaceById(access.workspaceId);
  const usage =
    access.appCode === WELDREACH_APP_CODE && ['approved', 'suspended', 'revoked'].includes(access.status)
      ? await getReachUsage(access.clerkOrgId)
      : undefined;

  return {
    access,
    usage,
    // Deleted workspaces are history only; viewers never get write controls.
    canWrite: identity.role !== 'viewer' && workspace?.deletionState !== 'deleted',
  };
}

export type AccessRequestPageData = NonNullable<Awaited<ReturnType<typeof loadAccessRequestPage>>>;
