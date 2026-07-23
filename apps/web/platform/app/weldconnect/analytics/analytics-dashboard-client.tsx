
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Clock,
  Zap,
  CheckCircle2,
  XCircle,
  BarChart3,
} from 'lucide-react';
import {
  LineChart,
  Line,
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
import { Link } from '@/lib/router';

interface AnalyticsDashboardClientProps {
  stats: any;
  trends: any;
  errorStats: any;
  performanceMetrics: any;
  slowExecutions: any[];
}

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
};

const COLORS = {
  success: '#10b981',
  failed: '#ef4444',
  running: '#3b82f6',
  pending: '#f59e0b',
};

export function AnalyticsDashboardClient({
  stats,
  trends,
  errorStats,
  performanceMetrics,
  slowExecutions,
}: AnalyticsDashboardClientProps) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.analytics },
  ]);

  const successRate = stats?.totalExecutions
    ? ((stats.successfulExecutions / stats.totalExecutions) * 100).toFixed(1)
    : 0;

  const pieData = [
    { name: t.weldconnect.analytics.charts.successful, value: stats?.successfulExecutions || 0, color: COLORS.success },
    { name: t.weldconnect.analytics.charts.failed, value: stats?.failedExecutions || 0, color: COLORS.failed },
    { name: t.weldconnect.executions.statuses.running, value: stats?.runningExecutions || 0, color: COLORS.running },
  ].filter(item => item.value > 0);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-8 w-8 text-primary" />
            {t.weldconnect.analytics.title}
          </h1>
          <p className="text-muted-foreground mt-2">
            {t.weldconnect.analytics.subtitle}
          </p>
        </div>

        {/* Overview Stats */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                {t.weldconnect.analytics.stats.totalExecutions}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalExecutions || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {t.weldconnect.analytics.stats.currentlyRunning.replace('{count}', String(stats?.runningExecutions || 0))}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                {t.weldconnect.analytics.stats.successRate}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{successRate}%</div>
              <p className="text-xs text-muted-foreground mt-1">
                {t.weldconnect.analytics.stats.successfulExecutions.replace('{count}', String(stats?.successfulExecutions || 0))}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-red-500" />
                {t.weldconnect.analytics.stats.failedExecutions}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{stats?.failedExecutions || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {t.weldconnect.analytics.stats.unacknowledgedErrors.replace('{count}', String(errorStats?.unacknowledgedErrors || 0))}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                {t.weldconnect.analytics.stats.avgDuration}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatDuration(stats?.averageDuration || 0)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t.weldconnect.analytics.stats.median.replace('{value}', formatDuration(performanceMetrics?.medianDuration || 0))}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Charts Tabs */}
        <Tabs defaultValue="trends" className="space-y-4">
          <TabsList>
            <TabsTrigger value="trends">{t.weldconnect.analytics.tabs.trends}</TabsTrigger>
            <TabsTrigger value="performance">{t.weldconnect.analytics.tabs.performance}</TabsTrigger>
            <TabsTrigger value="errors">{t.weldconnect.analytics.tabs.errors}</TabsTrigger>
            <TabsTrigger value="distribution">{t.weldconnect.analytics.tabs.distribution}</TabsTrigger>
          </TabsList>

          {/* Execution Trends */}
          <TabsContent value="trends" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t.weldconnect.analytics.charts.executionTrends}</CardTitle>
                <CardDescription>{t.weldconnect.analytics.charts.executionTrendsDescription}</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={trends?.data || []}>
                    <defs>
                      <linearGradient id="colorSuccess" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLORS.success} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={COLORS.success} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorFailed" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLORS.failed} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={COLORS.failed} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    />
                    <YAxis />
                    <Tooltip
                      labelFormatter={(value) => new Date(value).toLocaleDateString()}
                      formatter={(value: any) => [value, '']}
                    />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="successfulExecutions"
                      name={t.weldconnect.analytics.charts.successful}
                      stroke={COLORS.success}
                      fillOpacity={1}
                      fill="url(#colorSuccess)"
                    />
                    <Area
                      type="monotone"
                      dataKey="failedExecutions"
                      name={t.weldconnect.analytics.charts.failed}
                      stroke={COLORS.failed}
                      fillOpacity={1}
                      fill="url(#colorFailed)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Performance Metrics */}
          <TabsContent value="performance" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t.weldconnect.analytics.charts.durationMetrics}</CardTitle>
                  <CardDescription>{t.weldconnect.analytics.charts.durationMetricsDescription}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t.weldconnect.analytics.charts.average}</span>
                    <span className="text-lg font-semibold">
                      {formatDuration(performanceMetrics?.averageDuration || 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t.weldconnect.analytics.charts.median}</span>
                    <span className="text-lg font-semibold">
                      {formatDuration(performanceMetrics?.medianDuration || 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t.weldconnect.analytics.charts.p95}</span>
                    <span className="text-lg font-semibold">
                      {formatDuration(performanceMetrics?.p95Duration || 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t.weldconnect.analytics.charts.p99}</span>
                    <span className="text-lg font-semibold">
                      {formatDuration(performanceMetrics?.p99Duration || 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t pt-4">
                    <span className="text-sm text-muted-foreground">{t.weldconnect.analytics.charts.totalDuration}</span>
                    <span className="text-lg font-semibold">
                      {formatDuration(performanceMetrics?.totalDuration || 0)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t.weldconnect.analytics.charts.slowestExecutions}</CardTitle>
                  <CardDescription>{t.weldconnect.analytics.charts.slowestExecutionsDescription}</CardDescription>
                </CardHeader>
                <CardContent>
                  {slowExecutions.length > 0 ? (
                    <div className="space-y-2">
                      {slowExecutions.map((execution) => (
                        <Link
                          key={execution.id}
                          href={`/weldconnect/executions/${execution.id}`}
                          className="flex items-center justify-between p-3 bg-muted rounded-lg hover:bg-muted/80 transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{execution.workflowName}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(execution.startedAt).toLocaleString()}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Clock className="h-3.5 w-3.5 text-orange-500" />
                            <span className="text-sm font-semibold text-orange-600">
                              {formatDuration(execution.duration)}
                            </span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-8">
                      <Zap className="h-12 w-12 text-muted-foreground/30 mb-4" />
                      <p className="text-sm text-muted-foreground">{t.weldconnect.analytics.charts.noSlowExecutions}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>{t.weldconnect.analytics.charts.durationTrends}</CardTitle>
                <CardDescription>{t.weldconnect.analytics.charts.durationTrendsDescription}</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={trends?.data || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    />
                    <YAxis tickFormatter={(value) => formatDuration(value)} />
                    <Tooltip
                      labelFormatter={(value) => new Date(value).toLocaleDateString()}
                      formatter={(value: any) => [formatDuration(value), t.weldconnect.analytics.stats.avgDuration]}
                    />
                    <Line
                      type="monotone"
                      dataKey="averageDuration"
                      name={t.weldconnect.analytics.stats.avgDuration}
                      stroke="#8b5cf6"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Error Analytics */}
          <TabsContent value="errors" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t.weldconnect.analytics.charts.errorStats}</CardTitle>
                  <CardDescription>{t.weldconnect.analytics.charts.errorStatsDescription}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t.weldconnect.analytics.stats.totalErrors}</span>
                    <span className="text-2xl font-bold text-red-600">
                      {errorStats?.totalErrors || 0}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t.weldconnect.analytics.stats.unacknowledged}</span>
                    <span className="text-lg font-semibold text-orange-600">
                      {errorStats?.unacknowledgedErrors || 0}
                    </span>
                  </div>
                  <div className="border-t pt-4 space-y-2">
                    <p className="text-sm font-medium">{t.weldconnect.analytics.stats.errorsByType}</p>
                    {errorStats?.errorsByType && Object.keys(errorStats.errorsByType).length > 0 ? (
                      Object.entries(errorStats.errorsByType).map(([type, count]: [string, any]) => (
                        <div key={type} className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">{type}</span>
                          <span className="text-sm font-medium">{count}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">{t.weldconnect.analytics.stats.noErrors}</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t.weldconnect.analytics.charts.errorsByWorkflow}</CardTitle>
                  <CardDescription>{t.weldconnect.analytics.charts.errorsByWorkflowDescription}</CardDescription>
                </CardHeader>
                <CardContent>
                  {errorStats?.errorsByWorkflow && Object.keys(errorStats.errorsByWorkflow).length > 0 ? (
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart
                        data={Object.entries(errorStats.errorsByWorkflow)
                          .map(([workflowId, count]) => ({
                            name: workflowId.substring(0, 8),
                            errors: count,
                          }))
                          .sort((a: any, b: any) => b.errors - a.errors)
                          .slice(0, 10)}
                      >
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" />
                        <YAxis />
                        <Tooltip />
                        <Bar dataKey="errors" fill={COLORS.failed} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-8">
                      <CheckCircle2 className="h-12 w-12 text-green-500/30 mb-4" />
                      <p className="text-sm text-muted-foreground">{t.weldconnect.analytics.stats.noErrors}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Execution Distribution */}
          <TabsContent value="distribution" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t.weldconnect.analytics.charts.executionDistribution}</CardTitle>
                  <CardDescription>{t.weldconnect.analytics.charts.executionDistributionDescription}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        label={(entry) => `${entry.name}: ${entry.value}`}
                        outerRadius={100}
                        fill="#8884d8"
                        dataKey="value"
                      >
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t.weldconnect.analytics.charts.dailyVolume}</CardTitle>
                  <CardDescription>{t.weldconnect.analytics.charts.dailyVolumeDescription}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={trends?.data || []}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      />
                      <YAxis />
                      <Tooltip
                        labelFormatter={(value) => new Date(value).toLocaleDateString()}
                        formatter={(value: any) => [value, t.weldconnect.analytics.stats.totalExecutions]}
                      />
                      <Bar dataKey="totalExecutions" fill={COLORS.running} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
