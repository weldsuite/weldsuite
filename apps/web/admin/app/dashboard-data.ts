import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { getAppStats } from '@/lib/apps-data';

/** Everything the dashboard shows. */
export async function loadDashboardPage() {
  const admin = await requireAdmin();
  const appStats = await getAppStats();

  return {
    greetingName: admin.name?.split(' ')[0] || admin.email.split('@')[0],
    appStats,
  };
}

export type DashboardPageData = NonNullable<Awaited<ReturnType<typeof loadDashboardPage>>>;
