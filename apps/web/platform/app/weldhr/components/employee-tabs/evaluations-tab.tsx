/** Evaluation history and score trend for a single employee's profile. */

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useHrEvaluations } from '@/hooks/queries/use-weldhr-queries';
import { EvaluationDialog } from '../../evaluations/components/evaluation-dialog';
import { SectionCard, EmptyText } from '../page-kit';
import { ErrorBanner, ScoreBadge, StatusBadge, errorMessage, formatDate } from '../shared';

export function EmployeeEvaluationsTab({ employeeId }: { employeeId: string }) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');
  const { data: evaluations, isLoading, error } = useHrEvaluations({ employeeId });
  const [creating, setCreating] = useState(false);

  const trend = useMemo(() => {
    const scored = (evaluations ?? [])
      .filter((e) => e.overallScore !== null && e.submittedAt)
      .slice()
      .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
    return scored;
  }, [evaluations]);

  return (
    <SectionCard
      title={t('weldhr.evaluations.tab.title')}
      action={
        canCreate && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('weldhr.evaluations.newEvaluation')}
          </Button>
        )
      }
    >
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !evaluations || evaluations.length === 0 ? (
        <EmptyText>{t('weldhr.evaluations.tab.empty')}</EmptyText>
      ) : (
        <div className="space-y-4">
          {trend.length >= 2 && (
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs text-muted-foreground">{t('weldhr.evaluations.tab.trend')}</p>
              <ScoreTrendChart points={trend.map((e) => e.overallScore as number)} />
            </div>
          )}

          <div className="space-y-2">
            {evaluations.map((evaluation) => (
              <Link
                key={evaluation.id}
                to="/weldhr/evaluations/$evaluationId"
                params={{ evaluationId: evaluation.id }}
                className="block"
              >
                <Card className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-muted/40">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{evaluation.formName}</p>
                    <p className="text-xs text-muted-foreground">
                      {evaluation.periodStart || evaluation.periodEnd
                        ? `${formatDate(evaluation.periodStart)} – ${formatDate(evaluation.periodEnd)}`
                        : t('weldhr.evaluations.table.noPeriod')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge group="evaluation" status={evaluation.status} />
                    <ScoreBadge score={evaluation.overallScore} />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}

      {creating && <EvaluationDialog employeeId={employeeId} onClose={() => setCreating(false)} />}
    </SectionCard>
  );
}

/** Minimal inline line chart — no charting library needed for a single series. */
function ScoreTrendChart({ points }: { points: number[] }) {
  const width = 480;
  const height = 96;
  const padding = 8;
  const max = 100;
  const min = 0;

  const coords = points.map((value, i) => {
    const x = points.length === 1 ? width / 2 : padding + (i / (points.length - 1)) * (width - padding * 2);
    const y = height - padding - ((value - min) / (max - min || 1)) * (height - padding * 2);
    return `${x},${y}`;
  });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full" preserveAspectRatio="none">
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="text-primary"
        vectorEffect="non-scaling-stroke"
      />
      {coords.map((c, i) => {
        const [x, y] = c.split(',');
        return <circle key={i} cx={x} cy={y} r={3} className="fill-primary" />;
      })}
    </svg>
  );
}
