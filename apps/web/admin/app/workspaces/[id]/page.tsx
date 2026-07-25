import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getWorkspaceById, listWorkspaceMembers } from '@/lib/workspaces-data';
import { WorkspaceDetail } from './workspace-detail';

export const dynamic = 'force-dynamic';

export default async function WorkspaceDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await props.params;

  const workspace = await getWorkspaceById(id);
  if (!workspace) notFound();

  const members = await listWorkspaceMembers(workspace.id);

  return <WorkspaceDetail workspace={workspace} members={members} />;
}
