/**
 * A funnel result: a bar per step with people, conversion from the previous
 * step and time to convert; between steps, how many dropped off, with links to
 * the recordings of those people (when the viewer may watch recordings). A
 * breakdown adds a comparison table. With `display: 'trends'` it shows the
 * conversion of the people who entered per bucket, with `'time_to_convert'`
 * how long converting took (median, 90th percentile, histogram).
 */

import { useState } from 'react';
import { Play } from 'lucide-react';
import {
  funnelDropOffRecordingsSearch,
  funnelStepRecordingsSearch,
  type PanelFunnelResult,
  type PanelFunnelSpec,
  type PanelFunnelStepResult,
  type PanelTimeToConvertStats,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { formatBucket, formatDuration, formatNumber, formatPercent } from '../../lib/format';
import { recordingsHref } from '../../lib/links';
import { useDefinitionLabels } from '../definitions';
import { CategoryBarChart, ValueLineChart } from './charts';

interface FunnelResultViewProps {
  result: PanelFunnelResult;
  spec: PanelFunnelSpec;
  projectId: string;
  /** The viewer has `panel_recordings:read`: show the "watch" links. */
  canWatch?: boolean;
  /** Dashboard tiles: no links, no breakdown table. */
  compact?: boolean;
}

function StepBar({
  step,
  ratio,
  language,
}: Readonly<{
  step: PanelFunnelStepResult;
  ratio: number;
  language: string;
}>) {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.funnels;
  const tx = t.weldpanel.explore.funnels;
  const labels = useDefinitionLabels();
  const name = step.label && step.label !== step.event ? step.label : labels.event(step.event);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="min-w-0 truncate text-sm font-medium">
          <span className="mr-2 text-muted-foreground">{step.index + 1}</span>
          {name}
          {step.optional && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{tx.optionalBadge}</span>}
        </p>
        <p className="text-sm tabular-nums text-muted-foreground">
          {tf.people.replace('{count}', formatNumber(step.count, language))}
          {step.index > 0 && <span> · {tf.fromPrevious.replace('{percent}', formatPercent(step.conversionFromPrevious, language))}</span>}
        </p>
      </div>
      <div className="h-8 overflow-hidden rounded-md bg-muted">
        <div className="flex h-full items-center rounded-md bg-primary/80 px-2 text-xs font-medium text-primary-foreground" style={{ width: `${Math.max(ratio * 100, 1)}%` }}>
          {ratio >= 0.12 && formatPercent(ratio, language)}
        </div>
      </div>
      {step.avgSecondsFromPrevious !== null && (
        <p className="text-xs text-muted-foreground">{tf.avgTimeValue.replace('{duration}', formatDuration(step.avgSecondsFromPrevious))}</p>
      )}
    </div>
  );
}

/** Conversion of the people who entered in each bucket. */
function FunnelTrendView({ result }: Readonly<{ result: PanelFunnelResult }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.funnels.trend;
  const trend = result.trend ?? [];
  if (trend.length === 0) return <EmptyText>{tx.none}</EmptyText>;
  const data = trend.map((p) => ({ label: formatBucket(p.bucket, result.interval ?? 'day', language), conversion: p.conversion }));
  return (
    <div className="grid gap-3">
      <ValueLineChart
        data={data}
        series={[{ key: 'conversion', label: tx.conversion }]}
        locale={language}
        format={(v) => formatPercent(v, language)}
        axisFormat={(v) => formatPercent(v, language, 0)}
        yDomain={[0, 1]}
        legend={false}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead className="text-right">{tx.entered}</TableHead>
              <TableHead className="text-right">{tx.converted}</TableHead>
              <TableHead className="text-right">{tx.conversion}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trend.map((p) => (
              <TableRow key={p.bucket}>
                <TableCell>{formatBucket(p.bucket, result.interval ?? 'day', language)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(p.entered, language)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(p.converted, language)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(p.conversion, language)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function bucketLabel(from: number, to: number | null, labels: { range: string; openRange: string }): string {
  if (to === null) return labels.openRange.replace('{from}', formatDuration(from));
  return labels.range.replace('{from}', formatDuration(from)).replace('{to}', formatDuration(to));
}

/** How long converting took: overall, or between two steps. */
function TimeToConvertView({ result }: Readonly<{ result: PanelFunnelResult }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.funnels.timeToConvert;
  const [scope, setScope] = useState('overall');
  const ttc = result.timeToConvert;
  if (!ttc) return <EmptyText>{tx.none}</EmptyText>;
  const stats: PanelTimeToConvertStats = scope === 'overall' ? ttc.overall : (ttc.steps.find((s) => String(s.index) === scope) ?? ttc.overall);
  const duration = (seconds: number | null) => (seconds === null ? '–' : formatDuration(seconds));
  const data = stats.histogram.map((b) => ({ label: bucketLabel(b.fromSeconds, b.toSeconds, tx), count: b.count }));

  return (
    <div className="grid gap-4">
      {ttc.steps.length > 1 && (
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger size="sm" className="h-8 w-auto min-w-48" aria-label={tx.scope}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="overall">{tx.overall}</SelectItem>
            {ttc.steps.map((s) => (
              <SelectItem key={s.index} value={String(s.index)}>
                {format(tx.step, { from: s.index, to: s.index + 1 })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <KpiGrid className="sm:grid-cols-4">
        <KpiCard label={tx.median} value={duration(stats.medianSeconds)} />
        <KpiCard label={tx.p90} value={duration(stats.p90Seconds)} />
        <KpiCard label={tx.average} value={duration(stats.avgSeconds)} />
        <KpiCard label={tx.people} value={formatNumber(stats.count, language)} hint={format(tx.converted, { count: formatNumber(stats.count, language) })} />
      </KpiGrid>
      {stats.count === 0 ? <EmptyText>{tx.none}</EmptyText> : <CategoryBarChart data={data} series={[{ key: 'count', label: tx.people }]} locale={language} legend={false} />}
    </div>
  );
}

export function FunnelResultView({ result, spec, projectId, canWatch = false, compact = false }: Readonly<FunnelResultViewProps>) {
  const { t, language } = useI18n();
  const tf = t.weldpanel.analytics.funnels;
  const labels = useDefinitionLabels();

  if (spec.display === 'trends' || (spec.display === undefined && result.trend)) return <FunnelTrendView result={result} />;
  if (spec.display === 'time_to_convert' || (spec.display === undefined && result.timeToConvert)) return <TimeToConvertView result={result} />;

  // The result can briefly belong to an earlier spec (the query keeps the previous data while a
  // changed funnel loads): links built from a spec with other steps would point at the wrong
  // events or past its last step, so they wait until both agree.
  const watch = canWatch && !compact && spec.steps.length === result.steps.length;
  const stepName = (step: PanelFunnelStepResult) => (step.label && step.label !== step.event ? step.label : labels.event(step.event));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <p className="text-sm text-muted-foreground">{tf.overall}</p>
        <p className="text-2xl font-semibold tabular-nums">{formatPercent(result.overallConversion, language)}</p>
        {result.steps.length > 1 && (
          <p className="text-xs text-muted-foreground">
            {tf.overallHint.replace('{last}', formatNumber(result.steps[result.steps.length - 1]!.count, language)).replace('{first}', formatNumber(result.steps[0]!.count, language))}
          </p>
        )}
      </div>

      <ol className="grid gap-1">
        {result.steps.map((step, index) => (
          <li key={step.index} className="grid gap-1">
            {index > 0 && (
              <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 py-1 pl-6 text-xs', step.droppedOff > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                <span className="tabular-nums">{tf.droppedOff.replace('{count}', formatNumber(step.droppedOff, language))}</span>
                {watch && step.droppedOff > 0 && (
                  <Link
                    href={recordingsHref(funnelDropOffRecordingsSearch(spec, index, projectId))}
                    className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                  >
                    <Play className="size-3" aria-hidden />
                    {tf.watch.droppedAt}
                  </Link>
                )}
              </div>
            )}
            <StepBar step={step} ratio={step.conversionFromFirst} language={language} />
            {watch && step.count > 0 && (
              <Link
                href={recordingsHref(funnelStepRecordingsSearch(spec, index, projectId))}
                className="inline-flex items-center gap-1 pl-6 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <Play className="size-3" aria-hidden />
                {tf.watch.completed}
              </Link>
            )}
          </li>
        ))}
      </ol>

      {!compact && result.breakdowns && (
        <div className="overflow-x-auto">
          {result.breakdowns.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tf.noBreakdownData}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.weldpanel.analytics.insights.columns.breakdown}</TableHead>
                  {result.steps.map((step) => (
                    <TableHead key={step.index} className="text-right">
                      {stepName(step)}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">{tf.table.overall}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.breakdowns.map((row) => (
                  <TableRow key={row.value}>
                    <TableCell className="max-w-48 truncate font-medium" title={row.value}>
                      {row.value === 'Other' ? t.weldpanel.analytics.common.other : row.value}
                    </TableCell>
                    {row.steps.map((step) => (
                      <TableCell key={step.index} className="text-right tabular-nums">
                        {formatNumber(step.count, language)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">{formatPercent(row.overallConversion, language)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}
