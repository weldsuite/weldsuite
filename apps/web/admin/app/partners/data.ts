import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { listPartners } from '@/lib/partners-data';

/** Everything the partner list shows. */
export async function loadPartnersPage() {
  const identity = await requireAdmin();
  const result = await listPartners(identity);

  return {
    result,
    canWrite: identity.role !== 'viewer',
  };
}

export type PartnersPageData = NonNullable<Awaited<ReturnType<typeof loadPartnersPage>>>;
