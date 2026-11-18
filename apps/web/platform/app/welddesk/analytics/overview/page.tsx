/**
 * WeldDesk → Reports → Overview: a team lead's numbers from the live inbox
 * (ADR DESK-011). KPIs against the previous period, the backlog right now,
 * volume and time trends, and per channel, priority, agent and team.
 */

import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Clock, Inbox, ShieldCheck, Smile, Timer } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@weldsuite/ui/components/chart';
import { cn } from '@/lib/utils';
import {
  DESK_OVERVIEW_RANGES,
  useDeskReportsOverview,
  type DeskOverviewRange,
  type DeskReportPair,
  type DeskReportPerson,
  type DeskReportsOverview,
} from '@/hooks/queries/use-desk-reports-queries';
import { formatDuration, formatPercent, reportLabel } from '../lib/report-labels';
import { ReportShareActions } from '../schedules/report-share-actions';

type ReportsT = ReturnType<typeof useI18n>['t']['helpdesk']['reports'];

/** "Mar 9" for a day or week bucket, "Mar 26" for a month. */
function bucketLabel(label: string, bucket: DeskReportsOverview['range']['bucket']): string {
  if (bucket === 'month' && /^\d{4}-\d{2}$/.test(label)) {
    return new Date(`${label}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    return new Date(`${label}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return label;
}

/**
 * The change against the previous period, coloured by whether it is good:
 * more resolved is good, a longer response time is not.
 */
function Delta({
  pair,
  lowerIsBetter = false,
  t,
}: Readonly<{ pair: DeskReportPair<number | null>; lowerIsBetter?: boolean; t: ReportsT }>) {
  const { value, previous } = pair;
  if (value == null || previous == null || previous === 0) return null;
  const change = Math.round(((value - previous) / previous) * 100);
  if (change === 0) return <span className="text-muted-foreground">0% {t.vsPrevious}</span>;
  const up = change > 0;
  const good = up !== lowerIsBetter;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('inline-flex items-center', good ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
        <Icon className="h-3 w-3" aria-hidden />
        {Math.abs(change)}%
      </span>
      <span className="text-muted-foreground">{t.vsPrevious}</span>
    </span>
  );
}

function Hint({ children, delta }: Readonly<{ children?: ReactNode; delta?: ReactNode }>) {
  return (
    <span className="flex flex-col gap-0.5">
      {delta}
      {children && <span className="text-muted-foreground">{children}</span>}
    </span>
  );
}

function BreakdownList({
  rows,
  label,
  empty,
}: Readonly<{ rows: Array<{ key: string; count: number }>; label: (key: string) => string; empty: string }>) {
  if (rows.length === 0) return <EmptyText>{empty}</EmptyText>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.key} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span>{label(row.key)}</span>
            <span className="tabular-nums text-muted-foreground">{row.count.toLocaleString()}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted">
            <div className="h-1.5 rounded-full bg-primary" style={{ width: `${(row.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function PeopleTable({
  rows,
  fallbackName,
  t,
}: Readonly<{ rows: DeskReportPerson[]; fallbackName: string; t: ReportsT }>) {
  const columns: ListTableColumn<DeskReportPerson>[] = [
    { id: 'name', header: t.table.name, cell: (row) => row.name || fallbackName },
    { id: 'created', header: t.table.created, width: 'w-[90px]', align: 'right', cell: (row) => row.created.toLocaleString() },
    { id: 'resolved', header: t.table.resolved, width: 'w-[90px]', align: 'right', cell: (row) => row.resolved.toLocaleString() },
    {
      id: 'firstResponse',
      header: t.table.firstResponse,
      width: 'w-[130px]',
      align: 'right',
      cell: (row) => formatDuration(row.firstResponseAvg, t),
    },
    {
      id: 'resolution',
      header: t.table.resolution,
      width: 'w-[120px]',
      align: 'right',
      cell: (row) => formatDuration(row.resolutionAvg, t),
    },
    { id: 'csat', header: t.table.csat, width: 'w-[80px]', align: 'right', cell: (row) => formatPercent(row.csat) },
  ];
  return (
    <ListTable
      columns={columns}
      data={rows}
      rowKey={(row, index) => row.id ?? `none-${index}`}
      emptyMessage={t.table.empty}
      dense
    />
  );
}

function OverviewBody({ data, t }: Readonly<{ data: DeskReportsOverview; t: ReportsT }>) {
  const { kpis, counts, backlog, range } = data;

  const volumeConfig = {
    created: { label: t.charts.created, color: 'var(--chart-1)' },
    resolved: { label: t.charts.resolved, color: 'var(--chart-2)' },
  } satisfies ChartConfig;
  const timesConfig = {
    firstResponse: { label: t.charts.firstResponse, color: 'var(--chart-1)' },
    resolution: { label: t.charts.resolution, color: 'var(--chart-3)' },
  } satisfies ChartConfig;

  const series = data.series.map((point) => ({
    label: bucketLabel(point.label, range.bucket),
    created: point.created,
    resolved: point.resolved,
    firstResponse: point.firstResponseAvg == null ? null : Math.round((point.firstResponseAvg / 3600) * 10) / 10,
    resolution: point.resolutionAvg == null ? null : Math.round((point.resolutionAvg / 3600) * 10) / 10,
  }));
  const quiet = kpis.created.value === 0 && kpis.resolved.value === 0 && backlog.open === 0;

  return (
    <>
      <KpiGrid className="lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label={t.kpis.created}
          icon={Inbox}
          value={kpis.created.value.toLocaleString()}
          hint={<Hint delta={<Delta pair={kpis.created} t={t} />} />}
        />
        <KpiCard
          label={t.kpis.resolved}
          icon={CheckCircle2}
          value={kpis.resolved.value.toLocaleString()}
          hint={<Hint delta={<Delta pair={kpis.resolved} t={t} />} />}
        />
        <KpiCard
          label={t.kpis.firstResponseMedian}
          icon={Timer}
          value={formatDuration(kpis.firstResponseMedian.value, t)}
          hint={
            <Hint delta={<Delta pair={kpis.firstResponseMedian} lowerIsBetter t={t} />}>
              {counts.firstResponses > 0
                ? t.hints.firstResponse
                    .replace('{count}', counts.firstResponses.toLocaleString())
                    .replace('{average}', formatDuration(kpis.firstResponseAvg.value, t))
                : t.hints.none}
            </Hint>
          }
        />
        <KpiCard
          label={t.kpis.resolutionMedian}
          icon={Clock}
          value={formatDuration(kpis.resolutionMedian.value, t)}
          hint={
            <Hint delta={<Delta pair={kpis.resolutionMedian} lowerIsBetter t={t} />}>
              {counts.resolutions > 0
                ? t.hints.resolution
                    .replace('{count}', counts.resolutions.toLocaleString())
                    .replace('{average}', formatDuration(kpis.resolutionAvg.value, t))
                : t.hints.none}
            </Hint>
          }
        />
        <KpiCard
          label={t.kpis.slaCompliance}
          icon={ShieldCheck}
          value={formatPercent(kpis.slaCompliance.value)}
          tone={kpis.slaCompliance.value != null && kpis.slaCompliance.value < 90 ? 'warning' : 'default'}
          hint={
            <Hint delta={<Delta pair={kpis.slaCompliance} t={t} />}>
              {counts.slaMet + counts.slaBreached > 0
                ? t.hints.sla.replace('{met}', String(counts.slaMet)).replace('{breached}', String(counts.slaBreached))
                : t.hints.none}
            </Hint>
          }
        />
        <KpiCard
          label={t.kpis.csat}
          icon={Smile}
          value={formatPercent(kpis.csat.value)}
          hint={
            <Hint delta={<Delta pair={kpis.csat} t={t} />}>
              {counts.ratings > 0
                ? t.hints.csat
                    .replace('{count}', counts.ratings.toLocaleString())
                    .replace('{average}', (counts.ratingAverage ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 }))
                : t.hints.none}
            </Hint>
          }
        />
      </KpiGrid>

      <SectionCard title={t.backlog.title}>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { label: t.backlog.open, value: backlog.open },
            { label: t.backlog.unassigned, value: backlog.unassigned },
            { label: t.backlog.waiting, value: backlog.waiting },
          ].map((item) => (
            <div key={item.label} className="space-y-1">
              <dt className="text-sm text-muted-foreground">{item.label}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{item.value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>

      {quiet && <EmptyText>{t.empty}</EmptyText>}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title={t.charts.volume} description={t.charts.volumeDescription}>
          <ChartContainer config={volumeConfig} className="h-[260px] w-full">
            <BarChart accessibilityLayer data={series}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="created" fill="var(--color-created)" radius={4} />
              <Bar dataKey="resolved" fill="var(--color-resolved)" radius={4} />
            </BarChart>
          </ChartContainer>
        </SectionCard>
        <SectionCard title={t.charts.times} description={t.charts.timesDescription}>
          <ChartContainer config={timesConfig} className="h-[260px] w-full">
            <LineChart accessibilityLayer data={series}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
              <YAxis tickLine={false} axisLine={false} width={40} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Line dataKey="firstResponse" stroke="var(--color-firstResponse)" strokeWidth={2} dot={false} connectNulls />
              <Line dataKey="resolution" stroke="var(--color-resolution)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ChartContainer>
        </SectionCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title={t.charts.byChannel}>
          <BreakdownList rows={data.byChannel} label={(key) => reportLabel('channel', key, t)} empty={t.table.empty} />
        </SectionCard>
        <SectionCard title={t.charts.byPriority}>
          <BreakdownList rows={data.byPriority} label={(key) => reportLabel('priority', key, t)} empty={t.table.empty} />
        </SectionCard>
      </div>

      <SectionCard title={t.table.agents}>
        <PeopleTable rows={data.agents} fallbackName={t.labels.unassigned} t={t} />
      </SectionCard>
      <SectionCard title={t.table.teams}>
        <PeopleTable rows={data.teams} fallbackName={t.labels.noTeam} t={t} />
      </SectionCard>

      <p className="text-xs text-muted-foreground">{t.utcNote}</p>
    </>
  );
}

export default function DeskReportsOverviewPage() {
  const { t } = useI18n();
  const tr = t.helpdesk.reports;
  const router = useRouter();
  const [range, setRange] = useState<DeskOverviewRange>('last_30_days');
  const { data, isLoading, isError, refetch } = useDeskReportsOverview(range);

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tr.title, href: '/welddesk/reports' },
    { label: tr.overviewTitle },
  ]);

  let body: ReactNode;
  if (isLoading) body = <PageLoader fullScreen={false} />;
  else if (isError || !data) body = <ErrorState message={tr.loadError} onRetry={() => void refetch()} />;
  else body = <OverviewBody data={data} t={tr} />;

  return (
    <DashboardPage
      title={tr.title}
      description={tr.overviewDescription}
      actions={
        <>
          <Select value={range} onValueChange={(value) => setRange(value as DeskOverviewRange)}>
            <SelectTrigger size="sm" aria-label={tr.period} className="h-8 w-auto min-w-[10rem] shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DESK_OVERVIEW_RANGES.map((key) => (
                <SelectItem key={key} value={key}>
                  {tr.ranges[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ReportShareActions range={range} />
          <Button variant="outline" size="sm" onClick={() => router.push('/welddesk/reports/custom')}>
            {tr.customTitle}
          </Button>
        </>
      }
    >
      {body}
    </DashboardPage>
  );
}
