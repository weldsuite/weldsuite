import { loadPartnersPage } from './data';
import { PartnersPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadPartnersPage();
  return <PartnersPage {...data} />;
}
