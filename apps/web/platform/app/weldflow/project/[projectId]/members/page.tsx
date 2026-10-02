
import { useParams } from '@/lib/router';
import { MembersClient } from './members-client';
import { useProjectMembers, useProjectAvailableUsers } from '@/hooks/queries/use-projects-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { PageLoader } from '@/components/page-loader';

export default function MembersPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  // Server-derived: covers project role, the project manager, and workspace
  // admins (projects:scope:all) who may not have a member row at all.
  const { isAdmin, canWrite, isViewer, isLoading: permissionsLoading } = useProjectPermissions();

  const { data: membersData, isLoading: membersLoading } = useProjectMembers(projectId);
  const { data: availableData, isLoading: availableLoading } = useProjectAvailableUsers(projectId);

  if (membersLoading || availableLoading || permissionsLoading) return <PageLoader fullScreen={false} />;

  const members = membersData?.data || [];
  const availableUsers = availableData?.data || [];

  return (
    <MembersClient
      projectId={projectId}
      initialMembers={members}
      initialAvailableUsers={availableUsers}
      isAdmin={isAdmin}
      canWrite={canWrite}
      isViewer={isViewer}
    />
  );
}
