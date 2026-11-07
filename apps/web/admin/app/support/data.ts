import 'server-only';

import { listEnterpriseWorkspaces } from '@/lib/support-data';
import { requireAdmin } from '@/lib/auth';

/** Everything the support inbox page shows. */
export async function loadSupportPage() {
  await requireAdmin();
  const workspaces = await listEnterpriseWorkspaces();
  return { workspaces };
}

export type SupportPageData = NonNullable<Awaited<ReturnType<typeof loadSupportPage>>>;
