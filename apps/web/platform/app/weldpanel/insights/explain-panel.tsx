/**
 * "Explain this change" (root cause): for one series of the insight, which
 * values of the standard dimensions (country, device, browser, OS, referrer,
 * UTM source, page) account for the move between two periods, and on request
 * a short AI summary (charged, cached for a day, hidden when the project has
 * AI turned off). A side sheet over the builder.
 */

import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { PANEL_EXPLAINABLE_MATHS, type ExplainPanelChangeInput, type PanelExplainResult } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import { PANEL_FILTER_COLUMNS, type PanelFilterColumn, type PanelTrendsResult, type PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useExplainWeldPanelChange } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LabeledField } from '../components/labeled-field';
import { aiFailure } from '../lib/api-errors';
import { countryName, formatBucket, formatDateTime, formatNumber, formatPercent, formatSignedPercent } from '../lib/format';
import { seriesLetter } from '../lib/builders';

const RANGE = '__range__';
const BUCKET = /^\d{4}-\d{2}-\d{2}(T\d{2}:00)?$/;

export function isExplainable(math: string | undefined): boolean {
  return (PANEL_EXPLAINABLE_MATHS as readonly string[]).includes(math ?? 'total');
}

interface ExplainPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  spec: PanelTrendsSpec;
  /** The result on screen: its buckets can be compared one by one. */
  result: PanelTrendsResult | undefined;
  /** Labels of the spec's series (`A · Signed up`). */
  seriesLabels: string[];
  aiEnabled: boolean;
  /** The series to start with. */
  initialSeries?: number;
}

/** The single-series spec the endpoint takes: breakdowns, formulas and the drawing options left out. */
export function explainSpec(spec: PanelTrendsSpec, seriesIndex: number): PanelTrendsSpec {
  const series = spec.series[seriesIndex] ?? spec.series[0]!;
  return { ...spec, series: [series], breakdown: undefined, breakdowns: undefined, formulas: undefined, formulaOnly: undefined, display: undefined, compare: false };
}

function DimensionTable({ dimension, language }: Readonly<{ dimension: PanelExplainResult['dimensions'][number]; language: string }>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.explain;
  const tf = t.weldpanel.analytics.filters;
  const unknown = t.weldpanel.analytics.common.unknown;

  let title = dimension.dimension;
  if ((PANEL_FILTER_COLUMNS as readonly string[]).includes(dimension.dimension)) title = tf.columns[dimension.dimension as PanelFilterColumn];
  else if (dimension.dimension.startsWith('event:')) title = format(tx.eventProperty, { key: dimension.dimension.slice(6) });
  else if (dimension.dimension.startsWith('person:')) title = format(tx.personProperty, { key: dimension.dimension.slice(7) });

  const valueLabel = (value: string) => {
    if (value === '') return unknown;
    return dimension.dimension === 'country' ? countryName(value, language) : value;
  };

  return (
    <section className="grid gap-2" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">{format(tx.explained, { percent: formatPercent(Math.max(0, dimension.explained), language, 0) })}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            <TableHead className="text-right">{tx.baseline}</TableHead>
            <TableHead className="text-right">{tx.current}</TableHead>
            <TableHead className="text-right">{tx.change}</TableHead>
            <TableHead className="w-32">{tx.contribution}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dimension.values.map((v) => (
            <TableRow key={v.value}>
              <TableCell className="max-w-40 truncate font-medium" title={valueLabel(v.value)}>
                {valueLabel(v.value)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(v.baseline, language)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(v.current, language)}</TableCell>
              <TableCell className="text-right tabular-nums">{v.changePercent === null ? formatNumber(v.change, language) : formatSignedPercent(v.changePercent, language)}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded bg-muted" aria-hidden>
                    <div className="h-full rounded bg-primary/70" style={{ width: `${Math.min(100, Math.max(0, v.contributionShare) * 100)}%` }} />
                  </div>
                  <span className="w-10 text-right text-xs tabular-nums">{formatPercent(v.contributionShare, language, 0)}</span>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function ExplainPanel({ open, onOpenChange, projectId, spec, result, seriesLabels, aiEnabled, initialSeries = 0 }: Readonly<ExplainPanelProps>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.explain;
  const explain = useExplainWeldPanelChange();
  const narrate = useExplainWeldPanelChange();
  const [seriesIndex, setSeriesIndex] = useState(initialSeries);
  const [compare, setCompare] = useState(RANGE);

  // Each opening starts from the series it was opened for, with nothing run yet.
  const { reset: resetExplain } = explain;
  const { reset: resetNarrate } = narrate;
  useEffect(() => {
    if (!open) return;
    setSeriesIndex(initialSeries);
    setCompare(RANGE);
    resetExplain();
    resetNarrate();
  }, [open, initialSeries, resetExplain, resetNarrate]);

  const series = spec.series[seriesIndex];
  const explainable = isExplainable(series?.math);
  const buckets = useMemo(() => {
    const points = result?.series.find((s) => s.seriesIndex === seriesIndex && s.breakdownValue === null)?.points ?? result?.series[0]?.points ?? [];
    return points.map((p) => p.bucket).filter((b) => BUCKET.test(b));
  }, [result, seriesIndex]);

  const input: ExplainPanelChangeInput = {
    projectId,
    spec: { ...explainSpec(spec, seriesIndex), projectId },
    ...(compare === RANGE ? {} : { bucket: compare }),
  };

  const data = explain.data;
  const narrative = narrate.data?.narrative ?? data?.narrative ?? null;
  const unavailable = narrate.data?.narrativeUnavailable;
  const failure = narrate.error ? aiFailure(narrate.error) : null;

  let failureText: string | null = null;
  if (failure?.kind === 'credits') {
    failureText = failure.required !== null && failure.available !== null ? format(tx.ai.noCredits, { required: failure.required, available: failure.available }) : tx.ai.noCreditsGeneric;
  } else if (failure?.kind === 'disabled' || unavailable === 'ai_disabled') failureText = tx.ai.disabled;
  else if (unavailable === 'insufficient_credits') failureText = tx.ai.noCreditsGeneric;
  else if (unavailable === 'ai_unavailable') failureText = tx.ai.unavailable;
  else if (failure) failureText = tx.ai.failed;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{tx.title}</SheetTitle>
          <SheetDescription>{tx.description}</SheetDescription>
        </SheetHeader>

        <div className="grid gap-5 px-4 pb-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <LabeledField label={tx.series} htmlFor="weldpanel-explain-series">
              <Select
                value={String(seriesIndex)}
                onValueChange={(next) => {
                  setSeriesIndex(Number(next));
                  explain.reset();
                  narrate.reset();
                }}
              >
                <SelectTrigger id="weldpanel-explain-series">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {spec.series.map((s, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {seriesLetter(i)} · {seriesLabels[i] ?? s.event}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label={tx.compare} htmlFor="weldpanel-explain-compare">
              <Select
                value={compare}
                onValueChange={(next) => {
                  setCompare(next);
                  explain.reset();
                  narrate.reset();
                }}
              >
                <SelectTrigger id="weldpanel-explain-compare">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={RANGE}>{tx.compareRange}</SelectItem>
                  {buckets.slice(1).map((bucket) => (
                    <SelectItem key={bucket} value={bucket}>
                      {format(tx.compareBucket, { bucket: formatBucket(bucket, result?.interval ?? 'day', language) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
          </div>

          {!explainable ? (
            <InfoBanner variant="info">{tx.notExplainable}</InfoBanner>
          ) : (
            <div>
              <Button type="button" onClick={() => explain.mutate({ ...input, narrate: false })} disabled={explain.isPending}>
                {explain.isPending && <InlineSpinner />}
                {tx.run}
              </Button>
            </div>
          )}

          {explain.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <InlineSpinner />
              {tx.running}
            </p>
          )}
          {explain.error && <ErrorState message={tx.failed} onRetry={() => explain.mutate({ ...input, narrate: false })} retryLabel={t.weldpanel.retry} />}

          {data && (
            <div className="grid gap-5" data-testid="explain-result">
              <div className="grid gap-1 rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">{data.metric.label}</p>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-2xl font-semibold tabular-nums">{formatNumber(data.metric.current, language)}</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {tx.baseline}: {formatNumber(data.metric.baseline, language)}
                  </span>
                  {data.metric.changePercent !== null && <span className="text-sm font-medium tabular-nums">{formatSignedPercent(data.metric.changePercent, language)}</span>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {tx.current}: {formatDateTime(data.current.from, language)} – {formatDateTime(data.current.to, language)} · {tx.baseline}: {formatDateTime(data.baseline.from, language)} –{' '}
                  {formatDateTime(data.baseline.to, language)}
                </p>
              </div>

              {aiEnabled && (
                <section className="grid gap-2 rounded-lg border p-4" aria-label={tx.ai.title}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{tx.ai.title}</h3>
                    <Button type="button" size="sm" variant="outline" disabled={narrate.isPending} onClick={() => narrate.mutate({ ...input, narrate: true, regenerate: narrative !== null })}>
                      {narrate.isPending ? <InlineSpinner /> : <Sparkles />}
                      {narrative ? tx.ai.regenerate : tx.ai.generate}
                    </Button>
                  </div>
                  {!narrative && !failureText && <p className="text-xs text-muted-foreground">{tx.ai.creditsNote}</p>}
                  {narrate.isPending && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                      <InlineSpinner />
                      {tx.ai.running}
                    </p>
                  )}
                  {failureText && <InfoBanner variant={failure?.kind === 'failed' ? 'danger' : 'warning'}>{failureText}</InfoBanner>}
                  {narrative && (
                    <>
                      <p className="whitespace-pre-line text-sm leading-relaxed">{narrative.text}</p>
                      <p className="text-xs text-muted-foreground">{narrative.cached || narrative.creditsCharged === 0 ? tx.ai.cached : format(tx.ai.credits, { credits: narrative.creditsCharged })}</p>
                    </>
                  )}
                </section>
              )}

              {data.dimensions.length === 0 ? <EmptyText>{tx.noDimensions}</EmptyText> : data.dimensions.map((dimension) => <DimensionTable key={dimension.dimension} dimension={dimension} language={language} />)}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
