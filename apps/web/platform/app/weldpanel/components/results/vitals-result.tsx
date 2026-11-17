/**
 * A web vitals result: the percentile value with its rating and the 0-100
 * experience score, the good / needs improvement / poor split, the value over
 * time against Google's thresholds, and the worst pages, elements, countries
 * and devices.
 */

import type { ReactNode } from 'react';
import type { PanelVitalsResult, PanelVitalsRating, PanelVitalsRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { SegmentedBar } from '@weldsuite/ui/components/segmented-bar';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { countryName, formatBucket, formatNumber, formatPercent } from '../../lib/format';
import { ValueLineChart } from './charts';

const RATING_TONES: Record<PanelVitalsRating, SoftTone> = { good: 'success', needs_improvement: 'warning', poor: 'danger' };

/** `2 340 ms` as "2.34 s", `180` as "180 ms"; CLS as a plain number with three decimals. */
export function formatVital(value: number | null, unit: PanelVitalsResult['unit'], locale: string): string {
  if (value === null) return '–';
  if (unit === 'unitless') return new Intl.NumberFormat(locale, { maximumFractionDigits: 3, minimumFractionDigits: 2 }).format(value);
  if (value >= 1000) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / 1000)} s`;
  return `${formatNumber(Math.round(value), locale)} ms`;
}

export function RatingBadge({ rating }: Readonly<{ rating: PanelVitalsRating | null }>) {
  const { t } = useI18n();
  if (!rating) return null;
  return <SoftBadge tone={RATING_TONES[rating]}>{t.weldpanel.explore.performance.ratings[rating]}</SoftBadge>;
}

interface VitalsListProps {
  title: string;
  rows: PanelVitalsRow[];
  unit: PanelVitalsResult['unit'];
  valueLabel?: (value: string) => string;
  hint?: ReactNode;
}

export function VitalsList({ title, rows, unit, valueLabel = (v) => v, hint }: Readonly<VitalsListProps>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.performance;
  return (
    <section className="grid content-start gap-2" aria-label={title}>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {rows.length === 0 ? (
        <EmptyText>{t.weldpanel.analytics.common.noData}</EmptyText>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{title}</TableHead>
              <TableHead className="text-right">{tx.columns.value}</TableHead>
              <TableHead className="text-right">{tx.columns.samples}</TableHead>
              <TableHead className="text-right">{tx.columns.rating}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.value}>
                <TableCell className="max-w-64 truncate font-medium" title={valueLabel(row.value)}>
                  {valueLabel(row.value) || t.weldpanel.analytics.common.unknown}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatVital(row.metric, unit, language)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(row.samples, language)}</TableCell>
                <TableCell className="text-right">
                  <RatingBadge rating={row.rating} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** The summary tiles, the rating split and the chart over time. Lists are separate cards on the page. */
export function VitalsSummaryView({ result }: Readonly<{ result: PanelVitalsResult }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.performance;
  const data = result.series.map((p) => ({ label: formatBucket(p.bucket, result.interval, language), value: p.value }));
  const fmt = (v: number) => formatVital(v, result.unit, language);

  return (
    <div className="grid gap-5">
      <KpiGrid className="sm:grid-cols-3">
        <KpiCard
          label={format(tx.value, { percentile: result.percentile })}
          value={
            <span className="flex flex-wrap items-center gap-2">
              {formatVital(result.value, result.unit, language)}
              <RatingBadge rating={result.rating} />
            </span>
          }
          hint={format(tx.thresholds, { good: fmt(result.thresholds.good), poor: fmt(result.thresholds.poor) })}
        />
        <KpiCard label={tx.score} value={result.score === null ? '–' : formatNumber(Math.round(result.score), language)} hint={tx.scoreHint} />
        <KpiCard label={tx.columns.samples} value={formatNumber(result.samples, language)} hint={format(tx.samples, { count: formatNumber(result.samples, language) })} />
      </KpiGrid>

      <section className="grid gap-2" aria-label={tx.distribution}>
        <h3 className="text-sm font-medium">{tx.distribution}</h3>
        <SegmentedBar
          label={tx.distribution}
          formatShare={(share) => formatPercent(share, language, 0)}
          segments={[
            { key: 'good', label: tx.ratings.good, value: result.shares.good, tone: 'success' },
            { key: 'needs_improvement', label: tx.ratings.needs_improvement, value: result.shares.needsImprovement, tone: 'warning' },
            { key: 'poor', label: tx.ratings.poor, value: result.shares.poor, tone: 'danger' },
          ]}
        />
      </section>

      <section className="grid gap-2" aria-label={tx.overTime}>
        <h3 className="text-sm font-medium">{tx.overTime}</h3>
        <ValueLineChart
          data={data}
          series={[{ key: 'value', label: format(tx.value, { percentile: result.percentile }) }]}
          locale={language}
          format={fmt}
          legend={false}
          referenceLines={[
            { y: result.thresholds.good, label: tx.ratings.good, color: 'var(--color-emerald-500, #10b981)' },
            { y: result.thresholds.poor, label: tx.ratings.poor, color: 'var(--destructive)' },
          ]}
        />
      </section>
    </div>
  );
}

/** Compact view for a dashboard tile: the summary only. */
export function VitalsResultView({ result }: Readonly<{ result: PanelVitalsResult }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.performance;
  return (
    <div className="grid gap-4">
      <VitalsSummaryView result={result} />
      <div className="grid gap-4 lg:grid-cols-2">
        <VitalsList title={tx.paths} rows={result.paths} unit={result.unit} />
        <VitalsList title={tx.countries} rows={result.countries} unit={result.unit} valueLabel={(v) => (v ? countryName(v, language) : v)} />
      </div>
    </div>
  );
}
