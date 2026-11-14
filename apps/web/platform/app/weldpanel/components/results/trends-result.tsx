/** A trends result as a line or bar chart, a table or big numbers; compare adds the previous period. */

import { useMemo } from 'react';
import type { PanelTrendSeriesResult, PanelTrendsDisplay, PanelTrendsResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatBucket, formatNumber, formatSignedPercent, relativeChange } from '../../lib/format';
import { TimeSeriesChart, type ChartDatum, type ChartSeries } from '../charts/time-series-chart';

export type TrendsChartType = PanelTrendsDisplay;

export function trendsSeriesLabel(series: PanelTrendSeriesResult, otherLabel?: string): string {
  if (series.breakdownValue === null) return series.label;
  return `${series.label} · ${series.breakdownValue === 'Other' && otherLabel ? otherLabel : series.breakdownValue}`;
}

interface ChangeProps {
  current: number;
  previous: number | null | undefined;
  className?: string;
}

export function ChangeBadge({ current, previous, className }: Readonly<ChangeProps>) {
  const { language } = useI18n();
  const change = relativeChange(current, previous);
  if (change === null) return null;
  const tone = change > 0 ? 'text-emerald-600 dark:text-emerald-400' : change < 0 ? 'text-destructive' : 'text-muted-foreground';
  return <span className={cn('tabular-nums', tone, className)}>{formatSignedPercent(change, language)}</span>;
}

interface TrendsResultViewProps {
  result: PanelTrendsResult;
  chartType: TrendsChartType;
  className?: string;
}

export function TrendsResultView({ result, chartType, className }: Readonly<TrendsResultViewProps>) {
  const { t, language } = useI18n();
  const ti = t.weldpanel.analytics.insights;
  const other = t.weldpanel.analytics.common.other;

  const { data, series } = useMemo(() => {
    const buckets = [...new Set(result.series.flatMap((s) => s.points.map((p) => p.bucket)))].sort();
    const lines: ChartSeries[] = [];
    const rows: ChartDatum[] = buckets.map((bucket) => ({ label: formatBucket(bucket, result.interval, language) }));
    result.series.forEach((s, i) => {
      const label = trendsSeriesLabel(s, other);
      lines.push({ key: `s${i}`, label });
      const byBucket = new Map(s.points.map((p) => [p.bucket, p.value]));
      buckets.forEach((bucket, j) => {
        rows[j]![`s${i}`] = byBucket.get(bucket) ?? 0;
      });
      if (s.previous) {
        lines.push({ key: `p${i}`, label: ti.previousSuffix.replace('{label}', label), dashed: true, color: `var(--chart-${(i % 5) + 1})` });
        s.previous.points.forEach((point, j) => {
          if (rows[j]) rows[j][`p${i}`] = point.value;
        });
      }
    });
    return { data: rows, series: lines };
  }, [result, language, other, ti.previousSuffix]);

  if (chartType === 'number') {
    return (
      <div className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
        {result.series.map((s, i) => (
          <div key={`${s.seriesIndex}:${s.breakdownValue ?? ''}:${i}`} className="rounded-lg border p-4">
            <p className="truncate text-sm text-muted-foreground">{trendsSeriesLabel(s, other)}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{formatNumber(s.total, language)}</p>
            {s.previous && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t.weldpanel.analytics.common.previous}: {formatNumber(s.previous.total, language)} <ChangeBadge current={s.total} previous={s.previous.total} />
              </p>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (chartType === 'table') {
    const hasPrevious = result.series.some((s) => s.previous);
    return (
      <Table className={className}>
        <TableHeader>
          <TableRow>
            <TableHead>{ti.columns.series}</TableHead>
            <TableHead className="text-right">{ti.columns.total}</TableHead>
            {hasPrevious && <TableHead className="text-right">{ti.columns.previous}</TableHead>}
            {hasPrevious && <TableHead className="text-right">{ti.columns.change}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.series.map((s, i) => (
            <TableRow key={`${s.seriesIndex}:${s.breakdownValue ?? ''}:${i}`}>
              <TableCell className="max-w-72 truncate font-medium">{trendsSeriesLabel(s, other)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(s.total, language)}</TableCell>
              {hasPrevious && <TableCell className="text-right tabular-nums">{s.previous ? formatNumber(s.previous.total, language) : ''}</TableCell>}
              {hasPrevious && (
                <TableCell className="text-right">
                  <ChangeBadge current={s.total} previous={s.previous?.total} />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return <TimeSeriesChart data={data} series={series} type={chartType} locale={language} className={className} />;
}
