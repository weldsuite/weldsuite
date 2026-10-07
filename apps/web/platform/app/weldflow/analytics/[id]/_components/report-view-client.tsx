
import { useState, useEffect } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Link } from '@/lib/router';
import { ChevronLeft, Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';
import { analyticsApi } from '@/app/weldflow/lib/api-client';

// Type definitions (previously imported from actions)
export interface AnalyticsReport {
  id: string;
  title: string;
  description?: string;
  chartCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsChart {
  id: string;
  reportId: string;
  title: string;
  description?: string;
  chartType: string;
  entity: string;
  metric: string;
  color: string;
  timeRange?: string;
  groupBy?: string;
  aggregation?: string;
  sortOrder?: string;
  limit?: number;
  smoothCurve?: boolean;
  fillArea?: boolean;
  showDataLabels?: boolean;
  showLegend?: boolean;
}
import type { ChartDataPoint } from '../../lib/analytics-data';

// Chart components
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface ReportViewClientProps {
  report: AnalyticsReport;
  charts: AnalyticsChart[];
}

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export function ReportViewClient({ report, charts }: Readonly<ReportViewClientProps>) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.projects.title, href: '/weldflow' },
    { label: t.projects.analytics.title, href: '/weldflow/analytics' },
    { label: report.title },
  ]);

  const [chartData, setChartData] = useState<Record<string, ChartDataPoint[]>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      if (charts.length === 0) {
        setIsLoading(false);
        return;
      }

      try {
        const result = await analyticsApi.getChartsData(
          report.id,
          charts.map((chart) => ({
            chartId: chart.id,
            entity: chart.entity,
            metric: chart.metric,
            timeRange: chart.timeRange || 'last_30_days',
            groupBy: chart.groupBy || 'day',
            aggregation: chart.aggregation || 'sum',
            sortOrder: chart.sortOrder || 'asc',
            limit: chart.limit || undefined,
          })),
        );

        if (result?.success && result.data) {
          setChartData(result.data as Record<string, ChartDataPoint[]>);
        }
      } catch (error) {
        console.error('Failed to load chart data:', error);
      } finally {
        setIsLoading(false);
      }
    }

    void loadData();
  }, [charts, report.id]);

  const renderChart = (chart: AnalyticsChart, data: ChartDataPoint[]) => {
    if (!data || data.length === 0) {
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground">{t.projects.analyticsReports.noDataAvailable}</div>
      );
    }

    const chartType = chart.chartType;

    if (chartType.startsWith('area')) {
      return (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            {chart.showLegend && <Legend />}
            <Area
              type={chart.smoothCurve ? 'monotone' : 'linear'}
              dataKey="value"
              fill={chart.color}
              stroke={chart.color}
              fillOpacity={chart.fillArea ? 0.3 : 0}
            />
          </AreaChart>
        </ResponsiveContainer>
      );
    }

    if (chartType.startsWith('bar')) {
      return (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            {chart.showLegend && <Legend />}
            <Bar dataKey="value" fill={chart.color} />
          </BarChart>
        </ResponsiveContainer>
      );
    }

    if (chartType.startsWith('pie') || chartType.startsWith('radial')) {
      return (
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={chart.showDataLabels}
              label={chart.showDataLabels ? ({ name, percent }: { name?: string | number; percent?: number }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%` : undefined}
              outerRadius={100}
              innerRadius={chartType.includes('donut') ? 60 : 0}
              fill="#8884d8"
              dataKey="value"
              nameKey="label"
            >
              {data.map((entry, index) => (
                <Cell key={entry.label} fill={entry.fill || CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            {chart.showLegend && <Legend />}
          </PieChart>
        </ResponsiveContainer>
      );
    }

    // Default to bar chart
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Bar dataKey="value" fill={chart.color} />
        </BarChart>
      </ResponsiveContainer>
    );
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="-mx-3 md:-mx-4 -mt-3 md:-mt-4">
        <div className="flex items-center justify-between gap-4 px-3 md:px-4 h-[53px] border-b border-border pt-2 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 flex-shrink-0" asChild>
              <Link href="/weldflow/analytics">
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="text-sm font-medium truncate">{report.title}</h1>
            {report.description && (
              <p className="hidden md:block text-sm text-muted-foreground truncate">{report.description}</p>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 shadow-none" asChild>
              <Link href={`/weldflow/analytics/builder?reportId=${report.id}`}>
                {t.projects.analyticsReports.configure}
              </Link>
            </Button>
            <Button size="sm" className="h-8" asChild>
              <Link href={`/weldflow/analytics/builder?reportId=${report.id}&addChart=true`}>
                <Plus className="h-4 w-4 mr-0.5" />
                {t.projects.analyticsReports.addChart}
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col py-6">
        {charts.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-12">
            <div className="text-center">
              <h3 className="text-base font-semibold">{t.projects.analyticsReports.noCharts}</h3>
              <p className="text-sm text-muted-foreground mt-0.5">{t.projects.analyticsReports.noChartsDescription}</p>
              <Button size="sm" className="h-8 mt-4" asChild>
                <Link href={`/weldflow/analytics/builder?reportId=${report.id}&addChart=true`}>
                  <Plus className="h-4 w-4 mr-0.5" />
                  {t.projects.analyticsReports.addChart}
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {charts.map((chart) => (
              <Card key={chart.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{chart.title}</CardTitle>
                  {chart.description && <CardDescription>{chart.description}</CardDescription>}
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <div className="h-[300px]"><PageLoader fullScreen={false} /></div>
                  ) : (
                    renderChart(chart, chartData[chart.id] || [])
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
