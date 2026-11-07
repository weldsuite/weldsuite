import { loadActivityPage } from './data';
import { ActivityPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadActivityPage();
  return <ActivityPage {...data} />;
}
