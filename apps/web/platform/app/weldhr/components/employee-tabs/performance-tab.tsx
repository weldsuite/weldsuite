/** KPI snapshot and milestones for a single employee's profile. */

import { useMemo, useState } from 'react';
import { Check, CheckCircle2, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrKpiValue, HrMilestone } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrKpiValues,
  useHrMilestones,
  useUpdateHrMilestone,
} from '@/hooks/queries/use-weldhr-queries';
import { MilestoneDialog } from '../../performance/components/milestone-dialog';
import { SectionCard, EmptyText } from '../page-kit';
import { ErrorBanner, StatusBadge, errorMessage, formatDate, formatKpiValue } from '../shared';

export function EmployeePerformanceTab({ employeeId }: Readonly<{ employeeId: string }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');
  const canUpdate = can('evaluations:update');

  const { data: values, isLoading: valuesLoading, error: valuesError } = useHrKpiValues({ employeeId });
  const { data: milestones, isLoading: milestonesLoading, error: milestonesError } = useHrMilestones({ employeeId });
  const updateMilestone = useUpdateHrMilestone();
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; milestone: HrMilestone } | null>(null);

  const latestByKpi = useMemo(() => {
    const byKpi = new Map<string, HrKpiValue>();
    for (const v of values ?? []) {
      const current = byKpi.get(v.kpiId);
      if (!current || v.periodEnd > current.periodEnd) byKpi.set(v.kpiId, v);
    }
    return Array.from(byKpi.values());
  }, [values]);

  async function markAchieved(id: string) {
    try {
      await updateMilestone.mutateAsync({ id, status: 'achieved' });
    } catch {
      // Non-blocking; the row reflects the refetched state.
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard title={t('weldhr.performance.tab.kpisTitle')}>
        <ErrorBanner error={valuesError ? errorMessage(valuesError, t('weldhr.common.loadFailed')) : null} />
        {valuesLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : latestByKpi.length === 0 ? (
          <EmptyText>{t('weldhr.performance.tab.empty')}</EmptyText>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {latestByKpi.map((v) => (
              <Card key={v.kpiId} className="p-4">
                <p className="text-xs text-muted-foreground">{v.kpiName}</p>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold tabular-nums">{formatKpiValue(v.value, v.unit)}</span>
                  {v.onTarget !== null &&
                    (v.onTarget ? (
                      <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <X className="h-4 w-4 text-destructive" />
                    ))}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {v.target === null
                    ? t('weldhr.performance.tab.noValue')
                    : `${t('weldhr.performance.kpis.table.target')}: ${formatKpiValue(v.target, v.unit)}`}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {formatDate(v.periodStart)} – {formatDate(v.periodEnd)}
                </p>
              </Card>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t('weldhr.performance.tab.milestonesTitle')}
        action={
          canCreate && (
            <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('weldhr.performance.milestones.addMilestone')}
            </Button>
          )
        }
      >
        <ErrorBanner error={milestonesError ? errorMessage(milestonesError, t('weldhr.common.loadFailed')) : null} />
        {milestonesLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !milestones || milestones.length === 0 ? (
          <EmptyText>{t('weldhr.performance.tab.empty')}</EmptyText>
        ) : (
          <div className="space-y-2">
            {milestones.map((m) => (
              <Card key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{m.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`weldhr.status.milestoneType.${m.type}`)}
                    {m.dueDate ? ` · ${formatDate(m.dueDate)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge group="milestone" status={m.status} />
                  {canUpdate && m.status !== 'achieved' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void markAchieved(m.id)}
                      disabled={updateMilestone.isPending}
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      {t('weldhr.performance.milestones.markAchieved')}
                    </Button>
                  )}
                  {canUpdate && (
                    <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'edit', milestone: m })}>
                      {t('weldhr.common.edit')}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </SectionCard>

      {dialog?.kind === 'create' && <MilestoneDialog employeeId={employeeId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && (
        <MilestoneDialog milestone={dialog.milestone} employeeId={employeeId} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
