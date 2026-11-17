/**
 * A trends result as a line, bar, stacked area or pie chart, running totals
 * (`cumulative`), a table or big numbers; compare adds the previous period.
 * Formula lines (`A / B * 100`) are drawn next to the series, labelled by
 * their name or expression; several breakdowns read `NL / mobile`.
 */

import { useMemo } from 'react';
import type { PanelFormulaPoint, PanelTrendPoint, PanelTrendsDisplay, PanelTrendsResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatBucket, formatNumber, formatSignedPercent, relativeChange } from '../../lib/format';
import { TimeSeriesChart, type ChartDatum, type ChartSeries } from '../charts/time-series-chart';
import { useDefinitionLabels } from '../definitions';
import { StackedAreaChart, TotalsPieChart } from './charts';

export type TrendsChartType = PanelTrendsDisplay;

interface LabelledLine {
  label: string;
  breakdownValue: string | null;
  breakdownParts?: string[] | null;
}

/** "Signed up · NL / mobile": the series (or formula) label and its breakdown values; `Other` in the UI language. */
export function trendsSeriesLabel(series: LabelledLine, otherLabel?: string): string {
  if (series.breakdownValue === null) return series.label;
  const value = series.breakdownValue === 'Other' && otherLabel ? otherLabel : series.breakdownValue;
  return `${series.label} · ${value}`;
}

/** A series or formula as the views draw it. */
export interface TrendLine {
  key: string;
  kind: 'series' | 'formula';
  /** The spec's series index (series lines). */
  seriesIndex: number | null;
  label: string;
  total: number | null;
  points: (PanelTrendPoint | PanelFormulaPoint)[];
  previous: { total: number | null; points: (PanelTrendPoint | PanelFormulaPoint)[] } | null;
}

/** Series first, then formulas. `eventLabel` turns a custom event ref used as a label into its name. */
export function trendLines(result: PanelTrendsResult, otherLabel: string, eventLabel: (value: string) => string = (v) => v): TrendLine[] {
  const lines: TrendLine[] = result.series.map((s, i) => ({
    key: `s${i}`,
    kind: 'series',
    seriesIndex: s.seriesIndex,
    label: trendsSeriesLabel({ ...s, label: eventLabel(s.label) }, otherLabel),
    total: s.total,
    points: s.points,
    previous: s.previous,
  }));
  (result.formulas ?? []).forEach((f, i) => {
    lines.push({
      key: `f${i}`,
      kind: 'formula',
      seriesIndex: null,
      label: trendsSeriesLabel({ ...f, label: f.label || f.expression }, otherLabel),
      total: f.total,
      points: f.points,
      previous: f.previous,
    });
  });
  return lines;
}

/** Every bucket of the lines, in order. */
export function trendBuckets(lines: readonly TrendLine[]): string[] {
  return [...new Set(lines.flatMap((l) => l.points.map((p) => p.bucket)))].sort((a, b) => a.localeCompare(b));
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
  let tone = 'text-muted-foreground';
  if (change > 0) tone = 'text-emerald-600 dark:text-emerald-400';
  else if (change < 0) tone = 'text-destructive';
  return <span className={cn('tabular-nums', tone, className)}>{formatSignedPercent(change, language)}</span>;
}

function formatValue(value: number | null, locale: string): string {
  return value === null ? '–' : formatNumber(value, locale);
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
  const labels = useDefinitionLabels();
  const lines = useMemo(() => trendLines(result, other, labels.event), [result, other, labels]);
  const withPrevious = chartType !== 'area' && chartType !== 'pie';

  const { data, series } = useMemo(() => {
    const buckets = trendBuckets(lines);
    const chartSeries: ChartSeries[] = [];
    const rows: ChartDatum[] = buckets.map((bucket) => ({ label: formatBucket(bucket, result.interval, language), bucket }));
    lines.forEach((line, i) => {
      chartSeries.push({ key: line.key, label: line.label });
      const byBucket = new Map(line.points.map((p) => [p.bucket, p.value]));
      buckets.forEach((bucket, j) => {
        rows[j]![line.key] = byBucket.get(bucket) ?? (line.kind === 'formula' ? null : 0);
      });
      if (line.previous && withPrevious) {
        chartSeries.push({ key: `p${line.key}`, label: ti.previousSuffix.replace('{label}', line.label), dashed: true, color: `var(--chart-${(i % 5) + 1})` });
        line.previous.points.forEach((point, j) => {
          if (rows[j]) rows[j][`p${line.key}`] = point.value;
        });
      }
    });
    return { data: rows, series: chartSeries };
  }, [lines, result.interval, language, ti.previousSuffix, withPrevious]);

  if (chartType === 'number') {
    return (
      <div className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
        {lines.map((line) => (
          <div key={line.key} className="rounded-lg border p-4">
            <p className="truncate text-sm text-muted-foreground">{line.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{formatValue(line.total, language)}</p>
            {line.previous && line.total !== null && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t.weldpanel.analytics.common.previous}: {formatValue(line.previous.total, language)} <ChangeBadge current={line.total} previous={line.previous.total} />
              </p>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (chartType === 'table') {
    const hasPrevious = lines.some((l) => l.previous);
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
          {lines.map((line) => (
            <TableRow key={line.key}>
              <TableCell className="max-w-72 truncate font-medium">{line.label}</TableCell>
              <TableCell className="text-right tabular-nums">{formatValue(line.total, language)}</TableCell>
              {hasPrevious && <TableCell className="text-right tabular-nums">{line.previous ? formatValue(line.previous.total, language) : ''}</TableCell>}
              {hasPrevious && <TableCell className="text-right">{line.total !== null && <ChangeBadge current={line.total} previous={line.previous?.total} />}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (chartType === 'pie') {
    return <TotalsPieChart slices={lines.map((l) => ({ key: l.key, label: l.label, value: l.total ?? 0 }))} locale={language} className={className} />;
  }

  if (chartType === 'area') {
    return <StackedAreaChart data={data} series={series} locale={language} className={className} />;
  }

  // `cumulative` results already hold running totals: drawn as lines.
  return <TimeSeriesChart data={data} series={series} type={chartType === 'bar' ? 'bar' : 'line'} locale={language} className={className} />;
}
