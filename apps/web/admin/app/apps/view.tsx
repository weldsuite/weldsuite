import { AppsList } from './apps-list';
import type { AppsPageData } from './data';

export function AppsPage({ apps, stats, initialSearch, initialCategory }: Readonly<AppsPageData>) {
  return <AppsList apps={apps} stats={stats} initialSearch={initialSearch} initialCategory={initialCategory} />;
}
