'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { formatDate } from '@/lib/date';
import type { ClientTeamMemberDetail } from '@/lib/types';
import { milestoneStatusLabel } from '@/lib/labels';
import { Card } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

const MILESTONE_TONE = { achieved: 'positive', planned: 'neutral', in_progress: 'info', missed: 'negative' } as const;

export default function TeamMemberView() {
  const params = useParams();
  const slug = String(params.workspace ?? '');
  const employeeId = String(params.employeeId ?? '');
  const { dict, locale, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<ClientTeamMemberDetail>(slug, `/client/team/${employeeId}`);

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  const { member, milestones, evaluations, kpis } = data;
  const nothingShared = milestones.length === 0 && evaluations.length === 0 && kpis.length === 0;

  return (
    <div className="space-y-6">
      <Link href={`/${slug}/client`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={16} />
        {dict.common.back}
      </Link>

      <Card>
        <h1 className="text-xl font-semibold text-gray-900">{member.displayName}</h1>
        {member.jobTitle && <p className="text-sm text-gray-500">{member.jobTitle}</p>}
        {member.role && (
          <p className="text-sm text-gray-500 mt-1">
            {dict.client.teamMember.role}: {member.role}
          </p>
        )}
        <p className="text-xs text-gray-400 mt-1">{format(dict.client.teamMember.since, { date: formatDate(member.assignedSince, locale, timeZone) })}</p>
        {member.averageScore !== null && (
          <p className="text-sm text-gray-700 mt-2">
            {dict.client.overview.avgScore}: {member.averageScore}
          </p>
        )}
      </Card>

      {nothingShared ? (
        <Card>
          <EmptyState message={dict.client.teamMember.empty} />
        </Card>
      ) : (
        <>
          {kpis.length > 0 && (
            <Card>
              <h2 className="font-medium text-gray-900 mb-3">{dict.client.teamMember.kpis}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {kpis.map((kpi) => (
                  <div key={kpi.id} className="rounded-md border border-gray-100 p-3">
                    <p className="text-sm font-medium text-gray-900">{kpi.kpiName}</p>
                    <p className="text-xs text-gray-500">{format(dict.performance.period, { start: formatDate(kpi.periodStart, locale, timeZone), end: formatDate(kpi.periodEnd, locale, timeZone) })}</p>
                    <div className="flex items-baseline gap-2 mt-1">
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
            </Card>
          )}

          {evaluations.length > 0 && (
            <Card>
              <h2 className="font-medium text-gray-900 mb-3">{dict.client.teamMember.evaluations}</h2>
              <ul className="divide-y divide-gray-100">
                {evaluations.map((ev) => (
                  <li key={ev.id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900">{ev.formName || dict.evaluations.title}</p>
                      {ev.overallScore !== null && <Badge tone="info">{ev.overallScore}</Badge>}
                    </div>
                    {ev.periodStart && ev.periodEnd && (
                      <p className="text-xs text-gray-500">{format(dict.performance.period, { start: formatDate(ev.periodStart, locale, timeZone), end: formatDate(ev.periodEnd, locale, timeZone) })}</p>
                    )}
                    {ev.summary && <p className="text-sm text-gray-700 mt-1">{ev.summary}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {milestones.length > 0 && (
            <Card>
              <h2 className="font-medium text-gray-900 mb-3">{dict.client.teamMember.milestones}</h2>
              <ul className="divide-y divide-gray-100">
                {milestones.map((m) => (
                  <li key={m.id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900">{m.title}</p>
                      <Badge tone={MILESTONE_TONE[m.status]}>{milestoneStatusLabel(dict, m.status)}</Badge>
                    </div>
                    {m.description && <p className="text-sm text-gray-500 mt-0.5">{m.description}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
