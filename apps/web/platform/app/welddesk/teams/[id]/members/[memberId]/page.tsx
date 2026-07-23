
import { useParams, useRouter } from '@/lib/router';
import { MemberDetailClient } from './member-detail-client';
import { useHelpdeskAgent, useAgentTickets } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function MemberDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const teamId = params.id as string;
  const memberId = params.memberId as string;

  const { data: agentResult, isLoading: agentLoading } = useHelpdeskAgent(memberId);
  const { data: ticketsResult, isLoading: ticketsLoading } = useAgentTickets(memberId, { page: 1, limit: 10 });

  const isLoading = agentLoading || ticketsLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!agentResult?.success || !agentResult?.data) {
    router.push(`/welddesk/teams/${teamId}`);
    return null;
  }

  const agent = agentResult.data;
  const tickets = ticketsResult?.data || [];

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

  // Map tickets to expected format
  const recentTickets = tickets.map((ticket: any) => ({
    id: ticket.ticketNumber || ticket.id,
    subject: ticket.subject,
    customer: ticket.customerName,
    priority: ticket.priority,
    status: ticket.status,
    createdAt: new Date(ticket.createdAt),
  }));

  const memberData = {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    avatar: getInitials(agent.name),
    role: (agent.role || 'agent').replace('_', ' '),
    status: agent.isOnline ? 'online' as const : agent.availability === 'away' ? 'away' as const : 'offline' as const,
    activeTickets: agent.currentActiveTickets || 0,
    resolvedToday: agent.ticketsResolved || 0,
    avgResponseTime: formatResponseTime(agent.averageResponseTime),
    phone: '+1 (555) 123-4567', // Not in API type, using default
    department: agent.departmentId || t.helpdesk.memberDetailPage.locationUnknown,
    joinedDate: new Date(agent.createdAt),
    recentTickets,
    performanceMetrics: {
      totalResolved: agent.ticketsResolved || 0,
      avgSatisfactionRating: agent.satisfactionScore || 0,
      avgFirstResponseTime: formatResponseTime(agent.averageResponseTime),
      resolutionRate: agent.ticketsResolved && agent.ticketsAssigned
        ? Math.round((agent.ticketsResolved / agent.ticketsAssigned) * 100)
        : 0,
    },
  };

  return <MemberDetailClient memberData={memberData} teamId={teamId} />;
}
