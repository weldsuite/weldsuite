import { requireAdmin } from '@/lib/auth';
import { listApps, getAppStats } from '@/lib/apps-data';
import { AppsList } from './apps-list';

export const dynamic = 'force-dynamic';

export default async function AppsPage(props: {
  searchParams?: Promise<{ search?: string; category?: string }>;
}) {
  await requireAdmin();
  const searchParams = (await props.searchParams) ?? {};
  const search = (searchParams.search ?? '').trim();
  const category = (searchParams.category ?? '').trim();

  const [apps, stats] = await Promise.all([
    listApps({ search, category, includeInactive: true }),
    getAppStats(),
  ]);

  return <AppsList apps={apps} stats={stats} initialSearch={search} initialCategory={category} />;
}
