import { loadAppsPage } from './data';
import { AppsPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{
  searchParams?: Promise<{ search?: string; category?: string }>;
}>) {
  const data = await loadAppsPage((await props.searchParams) ?? {});
  return <AppsPage {...data} />;
}
