import { useParams } from '@/lib/router';
import { useSession } from '@clerk/clerk-react';
import { useProjectMembers, useProjectAvailableUsers } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';
import { SettingsClient } from './settings-client';

export default function ProjectSettingsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { session } = useSession();
  const userId = session?.user?.id;

  const { data: membersData, isLoading: membersLoading } = useProjectMembers(projectId);
  const { data: availableData, isLoading: availableLoading } = useProjectAvailableUsers(projectId);

  if (membersLoading || availableLoading) return <PageLoader fullScreen={false} />;

  const members = membersData?.data || [];
  const availableUsers = availableData?.data || [];

  const currentUserMember = members.find((m) => m.userId === userId);
  const isAdmin = currentUserMember?.role === 'owner' || currentUserMember?.role === 'admin';
  const canWrite = isAdmin || currentUserMember?.role === 'member';
  const isViewer = currentUserMember?.role === 'viewer';

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
