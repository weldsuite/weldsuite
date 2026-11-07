import { loadWeldmeetAiPricingPage } from './data';
import { WeldmeetAiPricingPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadWeldmeetAiPricingPage();
  return <WeldmeetAiPricingPage {...data} />;
}
