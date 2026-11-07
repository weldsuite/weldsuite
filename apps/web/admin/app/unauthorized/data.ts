import 'server-only';

import { getAdminIdentity } from '@/lib/auth';

/** Whether the visitor is an admin at all, which picks the message and the way out. */
export async function loadUnauthorizedPage() {
  // If a real admin lands here (e.g. a superadmin-only page), send them home.
  const identity = await getAdminIdentity();

  return { isAdmin: Boolean(identity) };
}

export type UnauthorizedPageData = NonNullable<Awaited<ReturnType<typeof loadUnauthorizedPage>>>;
