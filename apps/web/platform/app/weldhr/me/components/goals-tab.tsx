/** My HR → Goals: the latest value of each KPI against its target, and milestones. */

import { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfPerformance } from '@weldsuite/app-api-client/domains/weldhr';
import { useMyHrPerformance } from '@/hooks/queries/use-weldhr-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, StatusBadge, errorMessage, formatDate, formatKpiValue } from '../../components/shared';
import { Meta, TabLoading } from './shared';

type Kpi = HrSelfPerformance['kpis'][number];
type Milestone = HrSelfPerformance['milestones'][number];

/** One card per KPI, showing its most recent period. */
function latestPerKpi(kpis: Kpi[]): Kpi[] {
  const latest = new Map<string, Kpi>();
  for (const kpi of kpis) {
    const current = latest.get(kpi.kpiId);
    if (!current || kpi.periodEnd > current.periodEnd) latest.set(kpi.kpiId, kpi);
  }
  return Array.from(latest.values());
}

export function MyGoalsTab() {
  const t = useTranslations();

  function milestoneDateLabel(milestone: Milestone): string | null {
    if (milestone.achievedAt) return t('weldhr.me.goals.milestones.achievedOn', { date: formatDate(milestone.achievedAt) });
    if (milestone.dueDate) return t('weldhr.me.goals.milestones.due', { date: formatDate(milestone.dueDate) });
    return null;
  }

  const { data, isLoading, error } = useMyHrPerformance();
  const kpis = useMemo(() => latestPerKpi(data?.kpis ?? []), [data]);

  if (isLoading) return <TabLoading />;
  if (!data) return <ErrorBanner error={errorMessage(error, t('weldhr.me.goals.loadFailed'))} />;

  return (
    <div className="space-y-4">
      <SectionCard title={t('weldhr.me.goals.kpis.title')}>
        {kpis.length === 0 ? (
          <EmptyText>{t('weldhr.me.goals.kpis.empty')}</EmptyText>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {kpis.map((kpi) => (
              <div key={kpi.kpiId} className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">{kpi.kpiName}</p>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold tabular-nums">{formatKpiValue(kpi.value, kpi.unit)}</span>
                  {kpi.onTarget !== null &&
                    (kpi.onTarget ? (
                      <Check
                        className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                        aria-label={t('weldhr.me.goals.kpis.onTarget')}
                      />
                    ) : (
                      <X className="h-4 w-4 text-destructive" aria-label={t('weldhr.me.goals.kpis.offTarget')} />
                    ))}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {kpi.target === null
                    ? t('weldhr.me.goals.kpis.noTarget')
                    : t('weldhr.me.goals.kpis.target', { target: formatKpiValue(kpi.target, kpi.unit) })}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {formatDate(kpi.periodStart)} – {formatDate(kpi.periodEnd)}
                </p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t('weldhr.me.goals.milestones.title')}>
        {data.milestones.length === 0 ? (
          <EmptyText>{t('weldhr.me.goals.milestones.empty')}</EmptyText>
        ) : (
          <ul className="divide-y">
            {data.milestones.map((milestone) => (
              <li key={milestone.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{milestone.title}</p>
                  <StatusBadge group="milestone" status={milestone.status} />
                </div>
                {milestone.description && <p className="text-sm text-muted-foreground">{milestone.description}</p>}
                <Meta>
                  {[
                    t(`weldhr.status.milestoneType.${milestone.type}`),
                    milestoneDateLabel(milestone),
                    milestone.companyName,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Meta>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
