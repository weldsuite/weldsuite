'use client';

import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { formatDate } from '@/lib/date';
import type { HrClientView } from '@/lib/types';
import { milestoneStatusLabel } from '@/lib/labels';
import { Card, PageHeader } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

const MILESTONE_TONE = { achieved: 'positive', planned: 'neutral', in_progress: 'info', missed: 'negative' } as const;

/**
 * There's no standalone `/client/milestones` endpoint — the workforce
 * portal's `client/overview` response already carries the shared-milestones
 * list (see `buildClientView` in the backend), so this page reuses that call.
 */
export default function ClientMilestonesView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<HrClientView>(slug, '/client/overview');

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.client.milestones.title} />
      <Card>
        {data.milestones.length === 0 ? (
          <EmptyState message={dict.client.milestones.empty} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.milestones.map((m) => (
              <li key={m.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{m.title}</p>
                    <p className="text-xs text-gray-500">{m.employeeName}</p>
                  </div>
                  <Badge tone={MILESTONE_TONE[m.status]}>{milestoneStatusLabel(dict, m.status)}</Badge>
                </div>
                {m.description && <p className="text-sm text-gray-500 mt-1">{m.description}</p>}
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
