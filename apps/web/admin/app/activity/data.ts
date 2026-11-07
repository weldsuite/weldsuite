import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { listAuditEvents } from '@/lib/billing-data';

/** The latest audit events across every workspace. */
export async function loadActivityPage() {
  await requireAdmin();
  const events = await listAuditEvents({ limit: 300 });

  return { events };
}

export type ActivityPageData = NonNullable<Awaited<ReturnType<typeof loadActivityPage>>>;
