import { requireAdmin } from '@/lib/auth';
import { listWorkspaces } from '@/lib/workspaces-data';
import { WorkspacesList } from './workspaces-list';

export const dynamic = 'force-dynamic';

export default async function WorkspacesPage(props: {
  searchParams?: Promise<{ search?: string }>;
}) {
  await requireAdmin();
  const searchParams = (await props.searchParams) ?? {};
  const search = (searchParams.search ?? '').trim();

  const workspaces = await listWorkspaces({ search });

  return <WorkspacesList workspaces={workspaces} initialSearch={search} />;
}
