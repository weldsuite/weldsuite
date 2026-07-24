
import { useParams, useRouter } from '@/lib/router';
import { Users, MessageSquare, CheckCircle, Clock } from 'lucide-react';
import { EntityPageHeader, type StatItem } from '@/components/entity-overview/entity-page-header';
import { SupportTeamClient } from './support-team-client';
import { useDepartment, useHelpdeskAgents, useHelpdeskFeedback } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

interface RawTeamAgent {
  id: string;
  name: string;
  email: string;
  role?: string;
  currentActiveTickets?: number;
  ticketsResolved?: number;
  averageResponseTime?: number;
  isOnline?: boolean;
  availability?: string;
}

interface RawTeamFeedback {
  id: string;
  title: string;
  submitterName?: string;
  status: string;
  priority: string;
  assigneeName?: string;
  createdAt: string;
}

export default function SupportTeamPage() {
  const { t } = useI18n();
  const tm = t.helpdesk.teams;
  const params = useParams();
  const router = useRouter();
  const departmentId = (params.id as string) || 'support';

  const { data: deptResult, isLoading: deptLoading } = useDepartment(departmentId, !!departmentId);

  const { data: agentsResult, isLoading: agentsLoading } = useHelpdeskAgents({ departmentId });

  const { data: feedbackResult, isLoading: feedbackLoading } = useHelpdeskFeedback({ page: 1, pageSize: 10 });

  const isLoading = deptLoading || agentsLoading || feedbackLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!deptResult?.success || !deptResult?.data) {
    router.push('/welddesk/teams');
    return null;
  }

  const department = deptResult.data;
  const agents = agentsResult?.data || [];
  const feedbackItems = feedbackResult?.data || [];

  // Helper function to get initials
  const getInitials = (name: string) => {
    const parts = name.split(' ');
    return parts.map(part => part.charAt(0).toUpperCase()).join('').slice(0, 2);
  };

  // Helper function to format response time
  const formatResponseTime = (minutes?: number) => {
    if (!minutes) return '0h';
    if (minutes < 60) return `${Math.round(minutes)}m`;
    return `${(minutes / 60).toFixed(1)}h`;
  };

  // Map agents to team member format
  const members = agents.map((agent: RawTeamAgent) => ({
    id: agent.id,
    name: agent.name,
    email: agent.email,
    avatar: getInitials(agent.name),
    role: (agent.role || 'agent').replace('_', ' '),
    activeTickets: agent.currentActiveTickets || 0,
    resolvedToday: agent.ticketsResolved || 0,
    avgResponseTime: formatResponseTime(agent.averageResponseTime),
    status: agent.isOnline ? 'online' : agent.availability === 'away' ? 'away' : 'offline',
  }));

  // Map feedback to team format
  const recentFeedback = feedbackItems.slice(0, 10).map((feedback: RawTeamFeedback) => ({
    id: feedback.id,
    subject: feedback.title,
    customerName: feedback.submitterName,
    status: feedback.status,
    priority: feedback.priority,
    assignedTo: feedback.assigneeName || t.helpdesk.inbox.unassigned,
    createdAt: new Date(feedback.createdAt),
  }));

  const teamData = {
    id: department.id,
    name: department.name,
    description: department.description || tm.noDescription,
    color: 'bg-blue-500',
    members,
    recentFeedback,
  };

  const teamStats = {
    totalMembers: members.length,
    activeTickets: members.reduce((sum, member) => sum + member.activeTickets, 0),
    resolvedToday: members.reduce((sum, member) => sum + member.resolvedToday, 0),
    avgResponseTime: formatResponseTime(
      members.length > 0
        ? members.reduce((sum, member) => {
            const time = parseFloat(member.avgResponseTime);
            return sum + (isNaN(time) ? 0 : time);
          }, 0) / members.length
        : 0
    ),
  };

  const headerStats: StatItem[] = [
    { icon: Users, label: tm.teamMembers, count: teamStats.totalMembers, color: 'text-blue-600' },
    { icon: MessageSquare, label: tm.activeTickets, count: teamStats.activeTickets, color: 'text-orange-600' },
    { icon: CheckCircle, label: tm.resolvedToday, count: teamStats.resolvedToday, color: 'text-green-600' },
    { icon: Clock, label: tm.avgResponse, value: teamStats.avgResponseTime, color: 'text-purple-600' },
  ];

  return (
    <EntityPageHeader title={department.name} stats={headerStats}>
      <SupportTeamClient teamData={teamData} />
    </EntityPageHeader>
  );
}
