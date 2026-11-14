import { useMemo, useState } from 'react';
import { Clock, Eye, MousePointerClick, Percent, SquareCheck } from 'lucide-react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import type { FormDetail, FormInsights } from '@weldsuite/app-api-client/schemas/weldforms';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@weldsuite/ui/components/chart';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useFormInsights } from '@/hooks/queries/use-weldforms-results-queries';
import { RangeFilters, rangeQuery, type RangeValue } from './range-filters';
import { percentOf } from './summary-cards';

const NO_RANGE: RangeValue = { from: '', to: '', versionId: '' };

/** `84000` becomes `1m 24s`; null stays a dash. */
export function formatDuration(
  ms: number | null,
  labels: { seconds: string; minutes: string; hours: string },
  fill: (text: string, values: Record<string, string | number>) => string,
): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return fill(labels.hours, { h, m });
  if (m > 0) return fill(labels.minutes, { m, s });
  return fill(labels.seconds, { s });
}

export function InsightsTab({ form }: Readonly<{ form: FormDetail }>) {
  const { t, format, language } = useI18n();
  const ti = t.weldformsResults.results.insights;
  const [range, setRange] = useState<RangeValue>(NO_RANGE);
  const query = useFormInsights(form.id, rangeQuery(range, false));
  const insights = query.data;
  const number = new Intl.NumberFormat(language);
  const dayFormat = new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' });

  const chartConfig: ChartConfig = {
    views: { label: ti.series.views, color: 'var(--chart-1)' },
    starts: { label: ti.series.starts, color: 'var(--chart-2)' },
    completions: { label: ti.series.completions, color: 'var(--chart-3)' },
  };

  const maxReached = useMemo(() => Math.max(0, ...(insights?.dropOff ?? []).map((d) => d.reached)), [insights]);

  return (
    <div className="space-y-6">
      <RangeFilters formId={form.id} value={range} onChange={setRange} withVersion={false} />

      {query.error ? (
        <ErrorState onRetry={() => void query.refetch()} message={t.weldformsResults.common.loadFailed} />
      ) : (
        <>
          <InsightsKpis insights={insights} loading={query.isLoading} />

          <SectionCard title={ti.byDayTitle} description={ti.byDayDescription}>
            {insights && insights.byDay.length > 0 ? (
              <ChartContainer config={chartConfig} className="h-64 w-full">
                <LineChart data={insights.byDay} margin={{ left: 4, right: 12, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    tickFormatter={(value: string) => dayFormat.format(new Date(value))}
                  />
                  <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                  <ChartTooltip
                    content={<ChartTooltipContent labelFormatter={(value) => dayFormat.format(new Date(String(value)))} />}
                  />
                  <Line dataKey="views" type="monotone" stroke="var(--color-views)" strokeWidth={2} dot={false} />
                  <Line dataKey="starts" type="monotone" stroke="var(--color-starts)" strokeWidth={2} dot={false} />
                  <Line dataKey="completions" type="monotone" stroke="var(--color-completions)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            ) : (
              <p className="text-sm text-muted-foreground">{ti.noData}</p>
            )}
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard title={ti.dropOffTitle} description={ti.dropOffDescription}>
              {insights && insights.dropOff.length > 0 ? (
                <ol className="space-y-4">
                  {insights.dropOff.map((step, index) => (
                    <li key={step.blockId} className="space-y-1.5">
                      <p className="flex gap-2 text-sm font-medium">
                        <span className="tabular-nums text-muted-foreground">{index + 1}.</span>
                        <span className="min-w-0 flex-1 break-words">{step.title}</span>
                      </p>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-muted"
                        role="img"
                        aria-label={format(ti.reached, { count: step.reached })}
                      >
                        <div className="h-full rounded-full bg-primary" style={{ width: `${percentOf(step.reached, maxReached)}%` }} />
                      </div>
                      <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                        <span>{format(ti.reached, { count: step.reached })}</span>
                        <span>{format(ti.leftHere, { count: step.leftHere })}</span>
                        <span>{format(ti.dropOffRate, { percent: percentOf(step.dropOffRate, 1) })}</span>
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState title={ti.dropOffEmpty} />
              )}
            </SectionCard>

            <SectionCard title={ti.sourceTitle} description={ti.sourceDescription}>
              {insights && insights.bySource.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{ti.source}</TableHead>
                      <TableHead className="text-right">{ti.starts2}</TableHead>
                      <TableHead className="text-right">{ti.completions2}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {insights.bySource.map((row) => (
                      <TableRow key={row.source}>
                        <TableCell className="font-medium">{sourceLabel(row.source, ti.sources)}</TableCell>
                        <TableCell className="text-right tabular-nums">{number.format(row.starts)}</TableCell>
                        <TableCell className="text-right tabular-nums">{number.format(row.completions)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState title={ti.sourceEmpty} />
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}

/** The five headline numbers; a dash while there is nothing to show. */
function InsightsKpis({ insights, loading }: Readonly<{ insights: FormInsights | undefined; loading: boolean }>) {
  const { t, format, language } = useI18n();
  const ti = t.weldformsResults.results.insights;
  const number = new Intl.NumberFormat(language);
  const dash = t.weldformsResults.common.noValue;

  return (
    <KpiGrid className="lg:grid-cols-5">
      <KpiCard label={ti.views} value={insights ? number.format(insights.views) : dash} icon={Eye} loading={loading} />
      <KpiCard label={ti.starts} value={insights ? number.format(insights.starts) : dash} icon={MousePointerClick} loading={loading} />
      <KpiCard label={ti.completions} value={insights ? number.format(insights.completions) : dash} icon={SquareCheck} loading={loading} />
      <KpiCard
        label={ti.completionRate}
        value={insights?.completionRate == null ? dash : `${percentOf(insights.completionRate, 1)}%`}
        icon={Percent}
        loading={loading}
      />
      <KpiCard
        label={ti.averageTime}
        value={(insights && formatDuration(insights.averageDurationMs, ti.durationFormat, format)) ?? dash}
        icon={Clock}
        loading={loading}
      />
    </KpiGrid>
  );
}

function sourceLabel(source: string, labels: Record<string, string>): string {
  return Object.prototype.hasOwnProperty.call(labels, source) ? (labels[source] ?? source) : source || labels.unknown || source;
}
