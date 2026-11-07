import { loadAccessRequestsPage, type AccessRequestsSearchParams } from './data';
import { AccessRequestsPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{
  searchParams?: Promise<AccessRequestsSearchParams>;
}>) {
  const data = await loadAccessRequestsPage((await props.searchParams) ?? {});
  return <AccessRequestsPage {...data} />;
}
