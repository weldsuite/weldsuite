import { loadNewPlanPage } from './data';
import { NewPlanPage } from './view';

export default async function Page() {
  const data = await loadNewPlanPage();
  return <NewPlanPage {...data} />;
}
