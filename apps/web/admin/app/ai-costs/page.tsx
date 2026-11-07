import { loadAiCostsPage } from './data';
import { AiCostsPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadAiCostsPage();
  return <AiCostsPage {...data} />;
}
