import { useParams } from '@/lib/router';
import { useProjectMembers, useProjectAvailableUsers } from '@/hooks/queries/use-projects-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { PageLoader } from '@/components/page-loader';
import { SettingsClient } from './settings-client';

export default function ProjectSettingsPage() {
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
    <SettingsClient
      projectId={projectId}
      members={members}
      availableUsers={availableUsers}
      isAdmin={isAdmin}
      canWrite={canWrite}
      isViewer={isViewer}
    />
  );
}
