import { loadPhonePricingPage } from './data';
import { PhonePricingPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadPhonePricingPage();
  return <PhonePricingPage {...data} />;
}
