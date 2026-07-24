
import { useParams } from '@/lib/router';
import { MembersClient } from './members-client';
import { useProjectMembers, useProjectAvailableUsers } from '@/hooks/queries/use-projects-queries';
import { useSession } from '@clerk/clerk-react';
import { PageLoader } from '@/components/page-loader';

export default function MembersPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { session } = useSession();
  const userId = session?.user?.id;

  const { data: membersData, isLoading: membersLoading } = useProjectMembers(projectId);
  const { data: availableData, isLoading: availableLoading } = useProjectAvailableUsers(projectId);

  if (membersLoading || availableLoading) return <PageLoader fullScreen={false} />;

  const members = membersData?.data || [];
  const availableUsers = availableData?.data || [];

  // Determine user permissions based on their membership
  const currentUserMember = members.find((m) => m.userId === userId);
  const isAdmin = currentUserMember?.role === 'owner' || currentUserMember?.role === 'admin';
  const canWrite = isAdmin || currentUserMember?.role === 'member';
  const isViewer = currentUserMember?.role === 'viewer';

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
