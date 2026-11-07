import { loadDatabasesPage } from './data';
import { DatabasesPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadDatabasesPage();
  return <DatabasesPage {...data} />;
}
