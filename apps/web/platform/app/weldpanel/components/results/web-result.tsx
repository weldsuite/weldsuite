/** KPI tiles and the visitors/pageviews chart of a web result; the Overview and dashboard tiles both use them. */

import { Eye, Hourglass, MousePointerClick, TrendingDown, Users } from 'lucide-react';
import type { PanelWebResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { useI18n } from '@/lib/i18n/provider';
import { formatBucket, formatDuration, formatNumber, formatPercent } from '../../lib/format';
import { TimeSeriesChart, type ChartDatum, type ChartSeries } from '../charts/time-series-chart';
import { ChangeBadge } from './trends-result';

export function WebKpis({ result, loading }: Readonly<{ result: PanelWebResult | undefined; loading?: boolean }>) {
  const { t, language } = useI18n();
  const tk = t.weldpanel.analytics.overview.kpi;
  const totals = result?.totals;
  const previous = result?.previousTotals ?? null;

  const hint = (current: number | undefined, before: number | undefined) =>
    current !== undefined && before !== undefined && result?.previousTotals ? (
      <span className="inline-flex items-center gap-1">
        <ChangeBadge current={current} previous={before} /> {tk.vsPrevious}
      </span>
    ) : undefined;

  return (
    <KpiGrid className="sm:grid-cols-2 lg:grid-cols-5">
      <KpiCard label={tk.visitors} icon={Users} loading={loading || !totals} value={totals ? formatNumber(totals.visitors, language) : ''} hint={hint(totals?.visitors, previous?.visitors)} />
      <KpiCard label={tk.visits} icon={MousePointerClick} loading={loading || !totals} value={totals ? formatNumber(totals.visits, language) : ''} hint={hint(totals?.visits, previous?.visits)} />
      <KpiCard label={tk.pageviews} icon={Eye} loading={loading || !totals} value={totals ? formatNumber(totals.pageviews, language) : ''} hint={hint(totals?.pageviews, previous?.pageviews)} />
      <KpiCard label={tk.bounceRate} icon={TrendingDown} loading={loading || !totals} value={totals ? formatPercent(totals.bounceRate, language) : ''} hint={hint(totals?.bounceRate, previous?.bounceRate)} />
      <KpiCard
        label={tk.visitDuration}
        icon={Hourglass}
        loading={loading || !totals}
        value={totals ? formatDuration(totals.avgVisitDurationSeconds) : ''}
        hint={hint(totals?.avgVisitDurationSeconds, previous?.avgVisitDurationSeconds)}
      />
    </KpiGrid>
  );
}

export function WebChart({ result, className }: Readonly<{ result: PanelWebResult; className?: string }>) {
  const { t, language } = useI18n();
  const tc = t.weldpanel.analytics.overview.chart;
  const data: ChartDatum[] = result.series.map((point, index) => ({
    label: formatBucket(point.bucket, result.interval, language),
    visitors: point.visitors,
    pageviews: point.pageviews,
    ...(result.previousSeries?.[index] ? { previous: result.previousSeries[index]!.visitors } : {}),
  }));
  const series: ChartSeries[] = [
    { key: 'visitors', label: tc.visitors },
    { key: 'pageviews', label: tc.pageviews },
    ...(result.previousSeries ? [{ key: 'previous', label: tc.previous, dashed: true, color: 'var(--chart-1)' }] : []),
  ];
  return <TimeSeriesChart data={data} series={series} type="line" locale={language} className={className} legend />;
}
