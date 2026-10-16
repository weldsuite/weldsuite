
import { useMemo } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Link } from '@/lib/router';
import { ChevronLeft, Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';

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
import type { ChartDataPoint } from '@/app/weldflow/lib/api-client';
import { useProjectAnalyticsChartsData } from '@/hooks/queries/use-projects-queries';
import { AnalyticsChartView } from '../../_components/analytics-chart';

interface ReportViewClientProps {
  report: AnalyticsReport;
  charts: AnalyticsChart[];
}

export function ReportViewClient({ report, charts }: Readonly<ReportViewClientProps>) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.projects.title, href: '/weldflow' },
    { label: t.projects.analytics.title, href: '/weldflow/analytics' },
    { label: report.title },
  ]);

  const configs = useMemo(
    () =>
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
    [charts],
  );
  const { data: chartData = {}, isLoading, isError, refetch } = useProjectAnalyticsChartsData(report.id, configs);

  const renderChart = (chart: AnalyticsChart, data: ChartDataPoint[]) => {
    if (data.length === 0) {
      return (
        <div className="flex h-[300px] items-center justify-center text-muted-foreground">{t.projects.analyticsReports.noDataAvailable}</div>
      );
    }
    return (
      <AnalyticsChartView
        points={data}
        chartType={chart.chartType}
        color={chart.color}
        showLegend={chart.showLegend}
        smoothCurve={chart.smoothCurve}
        fillArea={chart.fillArea}
        showDataLabels={chart.showDataLabels}
        className="h-[300px] w-full"
      />
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
                  {isLoading && (
                    <div className="h-[300px]"><PageLoader fullScreen={false} /></div>
                  )}
                  {isError && (
                    <div className="flex h-[300px] flex-col items-center justify-center gap-3 text-center" role="alert">
                      <p className="text-sm text-muted-foreground">{t.projects.analyticsReports.chartsLoadFailed}</p>
                      <Button variant="outline" size="sm" onClick={() => void refetch()}>
                        {t.projects.analyticsReports.retry}
                      </Button>
                    </div>
                  )}
                  {!isLoading && !isError && renderChart(chart, chartData[chart.id] ?? [])}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
