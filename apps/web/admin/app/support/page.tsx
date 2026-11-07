import { loadSupportPage } from './data';
import { SupportPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadSupportPage();
  return <SupportPage {...data} />;
}
