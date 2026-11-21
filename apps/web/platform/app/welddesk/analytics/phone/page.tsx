/**
 * WeldDesk → Reports → Phone: call KPIs for a period (TASK-1229). The same
 * range picker and KPI style as the overview: each number against the previous
 * period, calls per period, calls by hour of day, and per agent and team.
 */

import { useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  Clock,
  Hourglass,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  Timer,
  Voicemail,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
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
import type { DeskPhoneReport } from '@weldsuite/core-api-client/schemas/helpdesk-live-reports';
import {
  DESK_OVERVIEW_RANGES,
  useDeskPhoneReport,
  type DeskOverviewRange,
} from '@/hooks/queries/use-desk-reports-queries';
import { formatDuration } from '../lib/report-labels';
import { bucketDateLabel, ReportDelta, ReportHint } from '../lib/report-delta';

type ReportsT = ReturnType<typeof useI18n>['t']['helpdesk']['reports'];
type PhoneT = ReturnType<typeof useI18n>['t']['helpdesk']['phoneReport'];

const PHONE_SETTINGS_HREF = '/settings/apps/welddesk/phone';

type AgentRow = DeskPhoneReport['agents'][number];
type TeamRow = DeskPhoneReport['teams'][number];

function AgentsTable({ rows, t, tr }: Readonly<{ rows: AgentRow[]; t: PhoneT; tr: ReportsT }>) {
  const columns: ListTableColumn<AgentRow>[] = [
    { id: 'name', header: t.table.name, cell: (row) => row.name },
    { id: 'answered', header: t.table.answered, width: 'w-[100px]', align: 'right', cell: (row) => row.answered.toLocaleString() },
    { id: 'handleAvg', header: t.table.handleAvg, width: 'w-[160px]', align: 'right', cell: (row) => formatDuration(row.handleAvg, tr) },
    { id: 'handleTotal', header: t.table.handleTotal, width: 'w-[160px]', align: 'right', cell: (row) => formatDuration(row.handleTotal, tr) },
  ];
  return <ListTable columns={columns} data={rows} rowKey={(row) => row.id} emptyMessage={t.table.empty} dense />;
}

function TeamsTable({ rows, t, tr }: Readonly<{ rows: TeamRow[]; t: PhoneT; tr: ReportsT }>) {
  const columns: ListTableColumn<TeamRow>[] = [
    // A team with no id is the general queue.
    { id: 'name', header: t.table.name, cell: (row) => (row.id === null ? t.table.generalQueue : (row.name ?? '')) },
    { id: 'offered', header: t.table.offered, width: 'w-[100px]', align: 'right', cell: (row) => row.offered.toLocaleString() },
    { id: 'answered', header: t.table.answered, width: 'w-[100px]', align: 'right', cell: (row) => row.answered.toLocaleString() },
    { id: 'missed', header: t.table.missed, width: 'w-[90px]', align: 'right', cell: (row) => row.missed.toLocaleString() },
    { id: 'abandoned', header: t.table.abandoned, width: 'w-[110px]', align: 'right', cell: (row) => row.abandoned.toLocaleString() },
    { id: 'waitAvg', header: t.table.waitAvg, width: 'w-[120px]', align: 'right', cell: (row) => formatDuration(row.waitAvg, tr) },
  ];
  return (
    <ListTable
      columns={columns}
      data={rows}
      rowKey={(row, index) => row.id ?? `general-${index}`}
      emptyMessage={t.table.empty}
      dense
    />
  );
}

function PhoneBody({ data, t, tr }: Readonly<{ data: DeskPhoneReport; t: PhoneT; tr: ReportsT }>) {
  const { kpis } = data;

  const callsConfig = {
    offered: { label: t.charts.offered, color: 'var(--chart-1)' },
    answered: { label: t.charts.answered, color: 'var(--chart-2)' },
    missed: { label: t.charts.missed, color: 'var(--chart-4)' },
    abandoned: { label: t.charts.abandoned, color: 'var(--chart-5)' },
  } satisfies ChartConfig;
  const hoursConfig = {
    offered: { label: t.charts.offered, color: 'var(--chart-1)' },
    answered: { label: t.charts.answered, color: 'var(--chart-2)' },
  } satisfies ChartConfig;

  const series = data.series.map((point) => ({ ...point, label: bucketDateLabel(point.date, data.bucket) }));
  const hours = data.hours.map((point) => ({ ...point, label: String(point.hour).padStart(2, '0') }));

  const duration = (value: number | null) => formatDuration(value, tr);

  return (
    <>
      <KpiGrid className="lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label={t.kpis.offered}
          icon={PhoneCall}
          value={kpis.offered.value.toLocaleString()}
          hint={<ReportHint delta={<ReportDelta {...kpis.offered} t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.answered}
          icon={PhoneIncoming}
          value={kpis.answered.value.toLocaleString()}
          hint={
            <ReportHint delta={<ReportDelta {...kpis.answered} t={tr} />}>
              {kpis.answerRate.value == null
                ? null
                : t.hints.answerRate.replace(
                    '{rate}',
                    `${kpis.answerRate.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
                  )}
            </ReportHint>
          }
        />
        <KpiCard
          label={t.kpis.missed}
          icon={PhoneMissed}
          value={kpis.missed.value.toLocaleString()}
          hint={<ReportHint delta={<ReportDelta {...kpis.missed} lowerIsBetter t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.abandoned}
          icon={PhoneOff}
          value={kpis.abandoned.value.toLocaleString()}
          hint={<ReportHint delta={<ReportDelta {...kpis.abandoned} lowerIsBetter t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.voicemail}
          icon={Voicemail}
          value={kpis.voicemail.value.toLocaleString()}
          hint={<ReportHint delta={<ReportDelta {...kpis.voicemail} lowerIsBetter t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.longestWait}
          icon={Hourglass}
          value={duration(kpis.longestWait.value)}
          hint={<ReportHint delta={<ReportDelta {...kpis.longestWait} lowerIsBetter t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.waitAvg}
          icon={Clock}
          value={duration(kpis.waitAvg.value)}
          hint={<ReportHint delta={<ReportDelta {...kpis.waitAvg} lowerIsBetter t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.waitMedian}
          icon={Clock}
          value={duration(kpis.waitMedian.value)}
          hint={<ReportHint delta={<ReportDelta {...kpis.waitMedian} lowerIsBetter t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.abandonAvg}
          icon={Timer}
          value={duration(kpis.abandonAvg.value)}
          hint={<ReportHint delta={<ReportDelta {...kpis.abandonAvg} neutral t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.handleAvg}
          icon={CheckCircle2}
          value={duration(kpis.handleAvg.value)}
          hint={<ReportHint delta={<ReportDelta {...kpis.handleAvg} neutral t={tr} />} />}
        />
        <KpiCard
          label={t.kpis.handleMedian}
          icon={CheckCircle2}
          value={duration(kpis.handleMedian.value)}
          hint={<ReportHint delta={<ReportDelta {...kpis.handleMedian} neutral t={tr} />} />}
        />
      </KpiGrid>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title={t.charts.calls}
          description={t.charts.callsDescription.replace('{bucket}', t.charts.bucket[data.bucket])}
        >
          <ChartContainer config={callsConfig} className="h-[260px] w-full">
            <BarChart accessibilityLayer data={series}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="offered" fill="var(--color-offered)" radius={4} />
              <Bar dataKey="answered" fill="var(--color-answered)" radius={4} />
              <Bar dataKey="missed" fill="var(--color-missed)" radius={4} />
              <Bar dataKey="abandoned" fill="var(--color-abandoned)" radius={4} />
            </BarChart>
          </ChartContainer>
        </SectionCard>
        <SectionCard title={t.charts.byHour} description={t.charts.byHourDescription}>
          <ChartContainer config={hoursConfig} className="h-[260px] w-full">
            <BarChart accessibilityLayer data={hours}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={1} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="offered" fill="var(--color-offered)" radius={4} />
              <Bar dataKey="answered" fill="var(--color-answered)" radius={4} />
            </BarChart>
          </ChartContainer>
        </SectionCard>
      </div>

      <SectionCard title={t.table.agents}>
        <AgentsTable rows={data.agents} t={t} tr={tr} />
      </SectionCard>
      <SectionCard title={t.table.teams}>
        <TeamsTable rows={data.teams} t={t} tr={tr} />
      </SectionCard>

      <p className="text-xs text-muted-foreground">{tr.utcNote}</p>
    </>
  );
}

export default function DeskPhoneReportPage() {
  const { t } = useI18n();
  const tp = t.helpdesk.phoneReport;
  const tr = t.helpdesk.reports;
  const router = useRouter();
  const [range, setRange] = useState<DeskOverviewRange>('last_30_days');
  const { data, isLoading, isError, refetch } = useDeskPhoneReport(range);

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tr.title, href: '/welddesk/reports' },
    { label: tp.title },
  ]);

  let body: ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError || !data) {
    body = <ErrorState message={tp.loadError} onRetry={() => void refetch()} />;
  } else if (data.kpis.offered.value === 0) {
    body = (
      <EmptyState
        icon={PhoneCall}
        title={tp.emptyTitle}
        description={tp.emptyDescription}
        action={
          <Button variant="outline" size="sm" onClick={() => router.push(PHONE_SETTINGS_HREF)}>
            {tp.emptyLink}
          </Button>
        }
      />
    );
  } else {
    body = <PhoneBody data={data} t={tp} tr={tr} />;
  }

  return (
    <DashboardPage
      title={tp.title}
      description={tp.description}
      actions={
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
      }
    >
      {body}
    </DashboardPage>
  );
}
