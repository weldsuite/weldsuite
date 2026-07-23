
import { useDepartments } from '@/hooks/queries/use-helpdesk-queries';
import { TeamsClient } from './teams-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function TeamsPage() {
  const { t } = useI18n();
  const { data, isLoading } = useDepartments();

  if (isLoading) return <PageLoader fullScreen={false} />;

  const departments = data?.data || [];

  // Color palette for teams
  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-purple-500',
    'bg-orange-500',
    'bg-pink-500',
    'bg-indigo-500',
    'bg-red-500',
    'bg-yellow-500',
  ];

  // Transform departments to team format
  const teams = departments.map((dept: any, index: number) => ({
    id: dept.id,
    name: dept.name,
    description: dept.description || t.helpdesk.teams.noDescription,
    members: dept.agentCount || 0,
    activeTickets: 0,
    resolvedToday: 0,
    avgResponseTime: '0h',
    color: colors[index % colors.length],
  }));

  return <TeamsClient teams={teams} />;
}
