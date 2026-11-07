import { loadNewAppPage } from './data';
import { NewAppPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadNewAppPage();
  return <NewAppPage {...data} />;
}
