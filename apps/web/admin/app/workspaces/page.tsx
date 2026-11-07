import { loadWorkspacesPage, type WorkspacesSearchParams } from './data';
import { WorkspacesPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{
  searchParams?: Promise<WorkspacesSearchParams>;
}>) {
  const data = await loadWorkspacesPage((await props.searchParams) ?? {});
  return <WorkspacesPage {...data} />;
}
