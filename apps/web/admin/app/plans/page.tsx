import { loadPlansPage } from './data';
import { PlansPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadPlansPage();
  return <PlansPage {...data} />;
}
