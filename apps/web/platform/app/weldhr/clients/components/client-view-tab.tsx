/** "What the client sees" — a read-only preview of the workforce portal's client view. */

import { Info } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrClientKpi, HrClientView } from '@weldsuite/app-api-client/domains/weldhr';
import {
  EmployeeAvatar,
  ScoreBadge,
  StatTile,
  StatusBadge,
  formatDate,
  formatKpiValue,
} from '../../components/shared';

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 100;
  const height = 24;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${height - ((v - min) / range) * height}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-6 w-24 text-primary" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function KpiCard({ kpi }: { kpi: HrClientKpi }) {
  const t = useTranslations();
  const trendValues = kpi.trend.map((p) => p.average);
  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{kpi.name}</p>
        {kpi.onTarget !== null && (
          <Badge variant={kpi.onTarget ? 'default' : 'destructive'}>
            {kpi.onTarget ? t('weldhr.clients.detail.clientView.kpis.onTarget') : t('weldhr.clients.detail.clientView.kpis.offTarget')}
          </Badge>
        )}
      </div>
      <p className="text-2xl font-semibold tabular-nums">
        {kpi.latest ? formatKpiValue(kpi.latest.average, kpi.unit) : '—'}
      </p>
      {kpi.target !== null && (
        <p className="text-xs text-muted-foreground">
          {t('weldhr.clients.detail.clientView.kpis.target')}: {formatKpiValue(kpi.target, kpi.unit)}
        </p>
      )}
      <Sparkline values={trendValues} />
    </Card>
  );
}

export function ClientViewTab({ clientView }: { clientView: HrClientView }) {
  const t = useTranslations();
  const { summary } = clientView;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {t('weldhr.clients.detail.clientView.infoBanner')}{' '}
          {clientView.individualScores
            ? t('weldhr.clients.detail.clientView.individualScoresOn')
            : t('weldhr.clients.detail.clientView.individualScoresOff')}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label={t('weldhr.clients.detail.clientView.summary.headcount')} value={summary.headcount} />
        <StatTile label={t('weldhr.clients.detail.clientView.summary.fte')} value={summary.fte.toFixed(1)} />
        <StatTile
          label={t('weldhr.clients.detail.clientView.summary.avgScore')}
          value={summary.averageEvaluationScore !== null ? summary.averageEvaluationScore.toFixed(1) : '—'}
        />
        <StatTile
          label={t('weldhr.clients.detail.clientView.summary.attendanceRate')}
          value={summary.attendanceRate30d !== null ? `${Math.round(summary.attendanceRate30d)}%` : '—'}
        />
        <StatTile label={t('weldhr.clients.detail.clientView.summary.milestonesAchieved')} value={summary.milestonesAchieved} />
        <StatTile label={t('weldhr.clients.detail.clientView.summary.milestonesOpen')} value={summary.milestonesOpen} />
      </div>

      {clientView.kpis.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t('weldhr.clients.detail.clientView.kpis.title')}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {clientView.kpis.map((kpi) => (
              <KpiCard key={kpi.kpiId} kpi={kpi} />
            ))}
          </div>
        </div>
      )}

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('weldhr.clients.detail.clientView.team.title')}</h3>
        {clientView.team.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('weldhr.clients.detail.clientView.team.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {clientView.team.map((member) => (
              <li key={member.employeeId} className="flex items-center justify-between gap-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <EmployeeAvatar name={member.displayName} src={member.avatarUrl} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{member.displayName}</span>
                    {member.jobTitle && <span className="block truncate text-xs text-muted-foreground">{member.jobTitle}</span>}
                  </span>
                </div>
                {clientView.individualScores && member.averageScore !== null && <ScoreBadge score={member.averageScore} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('weldhr.clients.detail.clientView.evaluations.title')}</h3>
          {clientView.evaluations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('weldhr.clients.detail.clientView.evaluations.empty')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {clientView.evaluations.map((ev) => (
                <li key={ev.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{ev.employeeName}</span>
                  <ScoreBadge score={ev.overallScore} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('weldhr.clients.detail.clientView.milestones.title')}</h3>
          {clientView.milestones.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('weldhr.clients.detail.clientView.milestones.empty')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {clientView.milestones.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {m.title} <span className="text-muted-foreground">· {m.employeeName}</span>
                  </span>
                  <StatusBadge group="milestone" status={m.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('weldhr.clients.detail.clientView.coaching.title')}</h3>
          {clientView.coaching.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('weldhr.clients.detail.clientView.coaching.empty')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {clientView.coaching.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {c.topic} <span className="text-muted-foreground">· {c.employeeName}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(c.sessionDate)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
