import { redirect } from 'next/navigation';
import { loadNewPartnerPage } from './data';
import { NewPartnerPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadNewPartnerPage();
  if (!data.canWrite) redirect('/partners');
  return <NewPartnerPage {...data} />;
}
