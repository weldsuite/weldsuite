import { loadDashboardPage } from './dashboard-data';
import { DashboardPage } from './dashboard-view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadDashboardPage();
  return <DashboardPage {...data} />;
}
