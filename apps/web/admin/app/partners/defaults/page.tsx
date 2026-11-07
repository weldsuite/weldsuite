import { loadPartnerContractDefaultsPage } from './data';
import { PartnerContractDefaultsPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadPartnerContractDefaultsPage();
  return <PartnerContractDefaultsPage {...data} />;
}
