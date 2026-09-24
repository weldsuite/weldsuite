'use client';

import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { formatDate } from '@/lib/date';
import type { EmployeePerformance } from '@/lib/types';
import { milestoneStatusLabel } from '@/lib/labels';
import { Card, PageHeader } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

const MILESTONE_TONE = { achieved: 'positive', planned: 'neutral', in_progress: 'info', missed: 'negative' } as const;

export default function PerformanceView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<EmployeePerformance>(slug, '/employee/performance');

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.performance.title} />

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.performance.kpis}</h2>
        {data.kpis.length === 0 ? (
          <EmptyState message={dict.performance.emptyKpis} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.kpis.map((kpi) => (
              <div key={kpi.id} className="rounded-md border border-gray-100 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900">{kpi.kpiName}</p>
                  {kpi.onTarget !== null && <Badge tone={kpi.onTarget ? 'positive' : 'warning'}>{kpi.onTarget ? dict.performance.onTarget : dict.performance.offTarget}</Badge>}
                </div>
                <p className="text-xs text-gray-500 mt-1">{format(dict.performance.period, { start: formatDate(kpi.periodStart, locale, timeZone), end: formatDate(kpi.periodEnd, locale, timeZone) })}</p>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-lg font-semibold text-gray-900">{kpi.value}</span>
                  {kpi.target !== null && (
                    <span className="text-xs text-gray-500">
                      {dict.performance.target}: {kpi.target}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.performance.milestones}</h2>
        {data.milestones.length === 0 ? (
          <EmptyState message={dict.performance.emptyMilestones} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.milestones.map((m) => (
              <li key={m.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-900">{m.title}</p>
                  <Badge tone={MILESTONE_TONE[m.status]}>{milestoneStatusLabel(dict, m.status)}</Badge>
                </div>
                {m.description && <p className="text-sm text-gray-500 mt-0.5">{m.description}</p>}
                <p className="text-xs text-gray-400 mt-1">
                  {m.achievedAt
                    ? format(dict.client.milestones.achievedOn, { date: formatDate(m.achievedAt, locale, timeZone) })
                    : m.dueDate
                      ? format(dict.client.milestones.due, { date: formatDate(m.dueDate, locale, timeZone) })
                      : dict.common.none}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
