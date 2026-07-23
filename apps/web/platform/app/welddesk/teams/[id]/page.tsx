
import { useParams, useRouter } from '@/lib/router';
import { SupportTeamClient } from './support-team-client';
import { useDepartment, useHelpdeskAgents, useHelpdeskUsers } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function TeamDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const departmentId = params.id as string;

  const { data: deptResult, isLoading: deptLoading } = useDepartment(departmentId, !!departmentId);

  const { data: agentsResult, isLoading: agentsLoading } = useHelpdeskAgents({ departmentId });

  const { data: usersResult, isLoading: usersLoading } = useHelpdeskUsers();

  const isLoading = deptLoading || agentsLoading || usersLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!deptResult?.success || !deptResult?.data) {
    router.push('/welddesk/teams');
    return null;
  }

  const department = deptResult.data;
  const agents = agentsResult?.data || [];
  const users = (usersResult?.data || []).map((u: any) => ({
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    firstName: u.firstName,
    lastName: u.lastName,
  }));

  const getInitials = (name: string) => {
    const parts = name.split(' ');
    return parts.map(part => part.charAt(0).toUpperCase()).join('').slice(0, 2);
  };

  const formatResponseTime = (minutes?: number) => {
    if (!minutes) return '0h';
    if (minutes < 60) return `${Math.round(minutes)}m`;
    return `${(minutes / 60).toFixed(1)}h`;
  };

  const members = agents.map((agent: any) => ({
    id: agent.id,
    name: agent.name,
    email: agent.email,
    avatar: getInitials(agent.name),
    role: (agent.role || 'agent').replace('_', ' '),
    activeTickets: agent.currentActiveTickets || 0,
    resolvedToday: agent.ticketsResolved || 0,
    avgResponseTime: formatResponseTime(agent.averageResponseTime),
    status: (agent.isOnline ? 'online' : agent.availability === 'away' ? 'away' : 'offline') as 'online' | 'away' | 'offline',
  }));

  return (
    <SupportTeamClient
      teamId={departmentId}
      teamName={department.name}
      teamDescription={department.description || t.helpdesk.teams.noDescription}
      initialMembers={members}
      initialFeedback={[]}
      users={users}
    />
  );
}
