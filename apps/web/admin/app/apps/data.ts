import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { listApps, getAppStats } from '@/lib/apps-data';

/** Everything the App Catalog list shows, filtered by the raw `search` / `category` params. */
export async function loadAppsPage(searchParams: { search?: string; category?: string }) {
  await requireAdmin();
  const search = (searchParams.search ?? '').trim();
  const category = (searchParams.category ?? '').trim();

  const [apps, stats] = await Promise.all([
    listApps({ search, category, includeInactive: true }),
    getAppStats(),
  ]);

  return {
    apps,
    stats,
    initialSearch: search,
    initialCategory: category,
  };
}

export type AppsPageData = NonNullable<Awaited<ReturnType<typeof loadAppsPage>>>;
