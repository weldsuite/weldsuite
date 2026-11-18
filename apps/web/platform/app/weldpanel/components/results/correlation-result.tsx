/**
 * A funnel correlation result: the events people did, and the properties of
 * their first step, that go with converting or with dropping off, strongest
 * first. A row that goes with dropping off links to the recordings of people
 * who dropped with it, when the viewer may watch recordings.
 */

import { Play, TrendingDown, TrendingUp } from 'lucide-react';
import type { PanelCorrelationRow, PanelFilterColumn, PanelFunnelCorrelationResult, PanelFunnelSpec, RecordingsSearch } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { countryName, formatNumber, formatPercent } from '../../lib/format';
import { recordingsHref } from '../../lib/links';
import { useDefinitionLabels } from '../definitions';

/** "Watch people who dropped off with this": did the first step (and the event), not the last step. */
export function correlationRecordingsSearch(spec: PanelFunnelSpec, row: PanelCorrelationRow, project?: string): RecordingsSearch | null {
  const first = spec.steps[0];
  const last = spec.steps[spec.steps.length - 1];
  if (!first || !last) return null;
  const range = spec.dateRange;
  const base: RecordingsSearch = {
    project,
    ...(range && 'preset' in range ? { range: range.preset } : {}),
    ...(range && 'from' in range ? { from: range.from, to: range.to } : {}),
    didNot: [last.event],
  };
  if (row.type === 'event') return { ...base, did: [first.event, row.value] };
  if (row.property === 'country') return { ...base, did: [first.event], countries: [row.value] };
  if (row.property === 'browser') return { ...base, did: [first.event], browsers: [row.value] };
  if (row.property === 'device_type' && (row.value === 'desktop' || row.value === 'tablet' || row.value === 'mobile')) return { ...base, did: [first.event], devices: [row.value] };
  return null;
}

interface CorrelationResultViewProps {
  result: PanelFunnelCorrelationResult;
  spec: PanelFunnelSpec;
  projectId: string;
  canWatch?: boolean;
}

function CorrelationTable({ title, rows, spec, projectId, canWatch }: Readonly<{ title: string; rows: PanelCorrelationRow[]; spec: PanelFunnelSpec; projectId: string; canWatch: boolean }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.funnels.correlation;
  const tf = t.weldpanel.analytics.filters;
  const labels = useDefinitionLabels();

  const valueLabel = (row: PanelCorrelationRow) => {
    if (row.type === 'event') return labels.event(row.value);
    const column = row.property ? tf.columns[row.property as PanelFilterColumn] ?? row.property : '';
    const value = row.property === 'country' ? countryName(row.value, language) : row.value || t.weldpanel.analytics.common.unknown;
    return column ? `${column}: ${value}` : value;
  };

  return (
    <section className="grid gap-2" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <EmptyText>{tx.none}</EmptyText>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx.columns.value}</TableHead>
                <TableHead className="text-right">{tx.columns.converted}</TableHead>
                <TableHead className="text-right">{tx.columns.dropped}</TableHead>
                <TableHead className="text-right">{tx.columns.rateWith}</TableHead>
                <TableHead className="text-right">{tx.columns.rateWithout}</TableHead>
                <TableHead className="text-right">{tx.columns.odds}</TableHead>
                {canWatch && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const positive = row.correlation === 'positive';
                const search = canWatch && !positive ? correlationRecordingsSearch(spec, row, projectId) : null;
                return (
                  <TableRow key={`${row.type}:${row.property ?? ''}:${row.value}`}>
                    <TableCell className="max-w-64">
                      <span className="flex items-center gap-2">
                        {positive ? (
                          <TrendingUp className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label={tx.positive} />
                        ) : (
                          <TrendingDown className="size-4 shrink-0 text-destructive" aria-label={tx.negative} />
                        )}
                        <span className="truncate font-medium" title={valueLabel(row)}>
                          {valueLabel(row)}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.successCount, language)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.failureCount, language)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPercent(row.successRateWith, language)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPercent(row.successRateWithout, language)}</TableCell>
                    <TableCell className={cn('text-right font-medium tabular-nums', positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                      {formatNumber(Math.round(row.oddsRatio * 100) / 100, language)}
                    </TableCell>
                    {canWatch && (
                      <TableCell className="text-right">
                        {search && (
                          <Link href={recordingsHref(search)} className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline" aria-label={`${tx.watch}: ${valueLabel(row)}`}>
                            <Play className="size-3" aria-hidden />
                            {tx.watch}
                          </Link>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

export function CorrelationResultView({ result, spec, projectId, canWatch = false }: Readonly<CorrelationResultViewProps>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.funnels.correlation;
  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">
        {format(tx.summary, { converted: formatNumber(result.converted, language), dropped: formatNumber(result.dropped, language) })}
      </p>
      <CorrelationTable title={tx.events} rows={result.events} spec={spec} projectId={projectId} canWatch={canWatch} />
      <CorrelationTable title={tx.properties} rows={result.properties} spec={spec} projectId={projectId} canWatch={canWatch} />
    </div>
  );
}
