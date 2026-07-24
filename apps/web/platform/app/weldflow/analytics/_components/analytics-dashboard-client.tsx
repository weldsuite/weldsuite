'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FolderKanban,
  Percent,
  ListTodo,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from '@weldsuite/ui/components/chart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectKpiSummary } from '@/hooks/queries/use-projects-queries';
import type { ProjectKpiPeriod, ProjectKpiSummary } from '@weldsuite/core-api-client/schemas/project-analytics';

const STATUS_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b'];
const HEALTH_COLORS: Record<string, string> = {
  on_track: '#10b981',
  at_risk: '#f59e0b',
  off_track: '#ef4444',
};

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  if (hours >= 100) return hours.toFixed(0);
  if (hours >= 10) return hours.toFixed(1);
  return hours.toFixed(1);
}

function toChartRows(record: Record<string, number>) {
  return Object.entries(record)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function buildStatusConfig(rows: { name: string; value: number }[]): ChartConfig {
  const config: ChartConfig = {};
  rows.forEach((row, i) => {
    config[row.name] = {
      label: row.name,
      color: STATUS_COLORS[i % STATUS_COLORS.length],
    };
  });
  return config;
}

function buildHealthConfig(rows: { name: string; value: number }[]): ChartConfig {
  const config: ChartConfig = {};
  rows.forEach((row) => {
    config[row.name] = {
      label: row.name.replace(/_/g, ' '),
      color: HEALTH_COLORS[row.name] ?? '#64748b',
    };
  });
  return config;
}

interface AnalyticsDashboardClientProps {
  projectId?: string;
  /** When true, hide the "Active projects" KPI (project-scoped view). */
  hideActiveProjects?: boolean;
}

export function AnalyticsDashboardClient({
  projectId,
  hideActiveProjects = !!projectId,
}: AnalyticsDashboardClientProps) {
  const { t } = useI18n();
  const td = t.projects.dashboard;
  const [period, setPeriod] = useState<ProjectKpiPeriod>('30d');

  const { data, isLoading, isError } = useProjectKpiSummary({ projectId, period });
  const summary = data?.data;

  const statusData = toChartRows(summary?.projectsByStatus ?? {});
  const healthData = toChartRows(summary?.projectsByHealth ?? {});
  const statusConfig = buildStatusConfig(statusData);
  const healthConfig = buildHealthConfig(healthData);
  const throughputConfig: ChartConfig = {
    completed: { label: td.completedTasks, color: 'hsl(var(--chart-1))' },
  };

  const cards = buildKpiCards(summary, td, hideActiveProjects);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.projects.analytics.title}</h1>
          <p className="text-muted-foreground">
            {projectId ? t.projects.analytics.projectAnalytics : t.projects.analyticsReports.description}
          </p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as ProjectKpiPeriod)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">{td.period7d}</SelectItem>
            <SelectItem value="30d">{td.period30d}</SelectItem>
            <SelectItem value="90d">{td.period90d}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: hideActiveProjects ? 5 : 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : isError || !summary ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {td.noChartData}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {cards.map((card) => (
              <Card key={card.label}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {card.label}
                  </CardTitle>
                  <card.icon className={`h-4 w-4 ${card.warn ? 'text-destructive' : 'text-muted-foreground'}`} />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${card.warn ? 'text-destructive' : ''}`}>
                    {card.value}
                  </div>
                  {card.sub ? (
                    <p className="text-xs text-muted-foreground mt-1">{card.sub}</p>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {!hideActiveProjects && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{td.projectsByStatus}</CardTitle>
                  <CardDescription>{td.projectsDashboard}</CardDescription>
                </CardHeader>
                <CardContent className="h-[260px]">
                  {statusData.length === 0 ? (
                    <EmptyChart message={td.noChartData} />
                  ) : (
                    <ChartContainer config={statusConfig} className="h-full w-full">
                      <PieChart>
                        <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
                        <Pie
                          data={statusData}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={50}
                          outerRadius={90}
                          strokeWidth={2}
                        >
                          {statusData.map((entry, i) => (
                            <Cell
                              key={entry.name}
                              fill={STATUS_COLORS[i % STATUS_COLORS.length]}
                            />
                          ))}
                        </Pie>
                        <ChartLegend content={<ChartLegendContent nameKey="name" />} />
                      </PieChart>
                    </ChartContainer>
                  )}
                </CardContent>
              </Card>
            )}

            {!hideActiveProjects && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{td.projectsByHealth}</CardTitle>
                </CardHeader>
                <CardContent className="h-[260px]">
                  {healthData.length === 0 ? (
                    <EmptyChart message={td.noChartData} />
                  ) : (
                    <ChartContainer config={healthConfig} className="h-full w-full">
                      <BarChart data={healthData} layout="vertical" margin={{ left: 12 }}>
                        <CartesianGrid horizontal={false} />
                        <YAxis dataKey="name" type="category" tickLine={false} axisLine={false} width={80}
                          tickFormatter={(v) => String(v).replace(/_/g, ' ')}
                        />
                        <XAxis type="number" allowDecimals={false} />
                        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                        <Bar dataKey="value" radius={4}>
                          {healthData.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={HEALTH_COLORS[entry.name] ?? '#64748b'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ChartContainer>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className={hideActiveProjects ? 'lg:col-span-2' : ''}>
              <CardHeader>
                <CardTitle className="text-base">{td.throughput}</CardTitle>
                <CardDescription>
                  {period === '7d' ? td.period7d : period === '90d' ? td.period90d : td.period30d}
                </CardDescription>
              </CardHeader>
              <CardContent className="h-[260px]">
                {(summary.throughputByDay?.length ?? 0) === 0 ? (
                  <EmptyChart message={td.noChartData} />
                ) : (
                  <ChartContainer config={throughputConfig} className="h-full w-full">
                    <AreaChart data={summary.throughputByDay} margin={{ left: 8, right: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => String(v).slice(5)}
                        minTickGap={24}
                      />
                      <YAxis allowDecimals={false} width={32} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Area
                        type="monotone"
                        dataKey="completed"
                        stroke="var(--color-completed)"
                        fill="var(--color-completed)"
                        fillOpacity={0.2}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function buildKpiCards(
  summary: ProjectKpiSummary | undefined,
  td: {
    activeProjects: string;
    tasksDueTodayLabel: string;
    overdueTasks: string;
    completionRate: string;
    hoursLogged: string;
    billableHours: string;
    hoursUnit: string;
  },
  hideActiveProjects: boolean,
) {
  if (!summary) return [];

  const hoursLabel = td.hoursUnit.replace('{hours}', formatHours(summary.hoursLoggedMinutes));
  const billableLabel = td.hoursUnit.replace('{hours}', formatHours(summary.billableHoursMinutes));

  const cards = [
    ...(hideActiveProjects
      ? []
      : [
          {
            label: td.activeProjects,
            value: String(summary.activeProjects),
            icon: FolderKanban,
            warn: false,
            sub: undefined as string | undefined,
          },
        ]),
    {
      label: td.tasksDueTodayLabel,
      value: String(summary.tasksDueToday),
      icon: ListTodo,
      warn: false,
      sub: undefined as string | undefined,
    },
    {
      label: td.overdueTasks,
      value: String(summary.overdueTasks),
      icon: AlertTriangle,
      warn: summary.overdueTasks > 0,
      sub: undefined as string | undefined,
    },
    {
      label: td.completionRate,
      value: `${summary.completionRate}%`,
      icon: Percent,
      warn: false,
      sub: `${summary.completedTasks}/${summary.totalTasks}`,
    },
    {
      label: td.hoursLogged,
      value: hoursLabel,
      icon: Clock,
      warn: false,
      sub: undefined as string | undefined,
    },
    {
      label: td.billableHours,
      value: billableLabel,
      icon: CheckCircle2,
      warn: false,
      sub: undefined as string | undefined,
    },
  ];

  return cards;
}
