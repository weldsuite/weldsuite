/**
 * A funnel result: a bar per step with people, conversion from the previous
 * step and time to convert; between steps, how many dropped off, with links to
 * the recordings of those people (when the viewer may watch recordings). A
 * breakdown adds a comparison table.
 */

import { Play } from 'lucide-react';
import {
  funnelDropOffRecordingsSearch,
  funnelStepRecordingsSearch,
  type PanelFunnelResult,
  type PanelFunnelSpec,
  type PanelFunnelStepResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { formatDuration, formatNumber, formatPercent } from '../../lib/format';
import { recordingsHref } from '../../lib/links';

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
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="min-w-0 truncate text-sm font-medium">
          <span className="mr-2 text-muted-foreground">{step.index + 1}</span>
          {step.label || step.event}
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

export function FunnelResultView({ result, spec, projectId, canWatch = false, compact = false }: Readonly<FunnelResultViewProps>) {
  const { t, language } = useI18n();
  const tf = t.weldpanel.analytics.funnels;
  const watch = canWatch && !compact;

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
                      {step.label || step.event}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">{tf.table.overall}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.breakdowns.map((row) => (
                  <TableRow key={row.value}>
                    <TableCell className="max-w-48 truncate font-medium">{row.value}</TableCell>
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
