'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { formatDate } from '@/lib/date';
import type { HrClientView } from '@/lib/types';
import { Card, PageHeader } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from '@/components/ui/sparkline';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-gray-100 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-gray-900 mt-0.5">{value}</p>
    </div>
  );
}

export default function ClientOverviewView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<HrClientView>(slug, '/client/overview');

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.client.overview.title} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatTile label={dict.client.overview.teamSize} value={data.summary.headcount} />
        <StatTile label={dict.client.overview.fte} value={data.summary.fte} />
        <StatTile label={dict.client.overview.avgEvaluationScore} value={data.summary.averageEvaluationScore ?? dict.client.overview.noScore} />
        <StatTile
          label={dict.client.overview.attendanceRate}
          value={data.summary.attendanceRate30d !== null ? `${Math.round(data.summary.attendanceRate30d * 100)}%` : dict.common.none}
        />
        <StatTile label={dict.client.overview.milestonesAchieved} value={data.summary.milestonesAchieved} />
        <StatTile label={dict.client.overview.milestonesOpen} value={data.summary.milestonesOpen} />
      </div>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.client.overview.kpis}</h2>
        {data.kpis.length === 0 ? (
          <EmptyState message={dict.client.overview.noKpis} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.kpis.map((kpi) => (
              <div key={kpi.kpiId} className="rounded-md border border-gray-100 p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{kpi.name}</p>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-lg font-semibold text-gray-900">{kpi.latest?.average ?? dict.common.none}</span>
                    {kpi.target !== null && (
                      <span className="text-xs text-gray-500">
                        {dict.performance.target}: {kpi.target}
                      </span>
                    )}
                  </div>
                  {kpi.onTarget !== null && (
                    <Badge tone={kpi.onTarget ? 'positive' : 'warning'} className="mt-1">
                      {kpi.onTarget ? dict.performance.onTarget : dict.performance.offTarget}
                    </Badge>
                  )}
                </div>
                <Sparkline values={kpi.trend.map((t) => t.average)} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.client.overview.team}</h2>
        {data.team.length === 0 ? (
          <EmptyState message={dict.client.teamMember.empty} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.team.map((member) => (
              <Link
                key={member.employeeId}
                href={`/${slug}/client/team/${member.employeeId}`}
                className="rounded-md border border-gray-100 p-3 hover:border-gray-300 transition-colors"
              >
                <p className="text-sm font-medium text-gray-900">{member.displayName}</p>
                {member.jobTitle && <p className="text-xs text-gray-500">{member.jobTitle}</p>}
                {member.role && <p className="text-xs text-gray-500">{member.role}</p>}
                <p className="text-xs text-gray-400 mt-1">{format(dict.client.overview.since, { date: formatDate(member.assignedSince, locale, timeZone) })}</p>
                {data.individualScores && (
                  <p className="text-xs text-gray-500 mt-1">
                    {dict.client.overview.avgScore}: {member.averageScore ?? dict.client.overview.noScore}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
