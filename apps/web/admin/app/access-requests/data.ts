import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { isAccessStatus, type AppAccessStatus } from '@/lib/app-access';
import { countAccessRequestsByStatus, listAccessRequests } from '@/lib/app-access-data';

export type AccessRequestsSearchParams = { status?: string; q?: string };

/** `requested` is the queue; `all` lifts the filter. */
function selectedStatus(status: string | undefined): AppAccessStatus | 'all' {
  if (status === 'all') return 'all';
  return isAccessStatus(status) ? status : 'requested';
}

/** The access requests matching the status tab and search, with the count per status. */
export async function loadAccessRequestsPage(searchParams: AccessRequestsSearchParams) {
  await requireAdmin();
  const q = (searchParams.q ?? '').trim();
  const selected = selectedStatus(searchParams.status);

  const [rows, counts] = await Promise.all([
    listAccessRequests({ status: selected === 'all' ? undefined : selected, search: q }),
    countAccessRequestsByStatus(),
  ]);

  return { rows, counts, q, selected };
}

export type AccessRequestsPageData = NonNullable<Awaited<ReturnType<typeof loadAccessRequestsPage>>>;
