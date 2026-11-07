import { loadDomainPricingPage } from './data';
import { DomainPricingPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadDomainPricingPage();
  return <DomainPricingPage {...data} />;
}
