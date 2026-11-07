import { loadUnauthorizedPage } from './data';
import { UnauthorizedPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await loadUnauthorizedPage();
  return <UnauthorizedPage {...data} />;
}
