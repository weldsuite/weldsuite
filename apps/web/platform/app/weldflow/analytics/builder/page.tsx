
import React, { useState } from 'react';
import { toast } from 'sonner';
import { useRouter, useSearchParams } from '@/lib/router';
import { useCreateProjectAnalyticsChart } from '@/hooks/queries/use-projects-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  ChevronDown, BarChart3, PieChart, Activity, TrendingUp,
  AreaChart as AreaChartIcon, Layers, FolderKanban, CheckSquare, Clock,
  Target, Plus, Divide, ArrowUp, ArrowDown, TrendingUpDown, SortAsc, SortDesc
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@weldsuite/ui/components/card"
import { ChartPreview } from '@/app/weldflow/analytics/_components/chart-preview';

const chartTypeDefs = [
  {
    id: 'area-chart',
    icon: AreaChartIcon,
  },
  {
    id: 'area-linear',
    icon: AreaChartIcon,
  },
  {
    id: 'area-stacked',
    icon: Layers,
  },
  {
    id: 'bar-multiple',
    icon: BarChart3,
  },
  {
    id: 'bar-mixed',
    icon: BarChart3,
  },
  {
    id: 'bar-stacked',
    icon: Layers,
  },
  {
    id: 'bar-negative',
    icon: TrendingUpDown,
  },
  {
    id: 'pie-label',
    icon: PieChart,
  },
  {
    id: 'pie-donut',
    icon: Activity,
  },
  {
    id: 'radar-lines',
    icon: Activity,
  },
  {
    id: 'radial-simple',
    icon: Activity,
  },
  {
    id: 'radial-text',
    icon: Activity,
  },
];

// Projects-specific entities
const entityDefs = [
  { id: 'projects', icon: FolderKanban },
  { id: 'tasks', icon: CheckSquare },
  { id: 'time_entries', icon: Clock },
  { id: 'milestones', icon: Target },
];

// Projects-specific metrics
const metricDefs: Record<string, Array<{ id: string }>> = {
  projects: [
    { id: 'total_projects' },
    { id: 'active_projects' },
    { id: 'projects_by_status' },
    { id: 'projects_by_health' },
    { id: 'completion_rate' },
    { id: 'budget_utilization' },
    { id: 'hours_utilization' },
    { id: 'avg_progress' },
    { id: 'projects_by_day' },
  ],
  tasks: [
    { id: 'total_tasks' },
    { id: 'completed_tasks' },
    { id: 'overdue_tasks' },
    { id: 'tasks_by_status' },
    { id: 'tasks_by_priority' },
    { id: 'tasks_by_type' },
    { id: 'throughput' },
    { id: 'estimation_accuracy' },
    { id: 'tasks_by_day' },
  ],
  time_entries: [
    { id: 'total_hours' },
    { id: 'billable_hours' },
    { id: 'non_billable_hours' },
    { id: 'utilization_rate' },
    { id: 'total_cost' },
    { id: 'hours_by_day' },
  ],
  milestones: [
    { id: 'total_milestones' },
    { id: 'milestones_by_status' },
    { id: 'completed_milestones' },
    { id: 'overdue_milestones' },
    { id: 'on_time_milestones' },
    { id: 'avg_milestone_progress' },
  ],
};

export default function ProjectsAnalyticsBuilderPage() {
  const { t } = useI18n();
  const catalog = t.projects.analyticsBuilderCatalog;
  const chartTypes = React.useMemo(() => {
    const names: Record<string, { name: string; description: string }> = catalog.chartTypes;
    return chartTypeDefs.map((chart) => ({ ...chart, ...names[chart.id] }));
  }, [catalog]);
  const entities = React.useMemo(() => {
    const names: Record<string, string> = catalog.entities;
    return entityDefs.map((entity) => ({ ...entity, name: names[entity.id] }));
  }, [catalog]);
  const metrics = React.useMemo(() => {
    const names: Record<string, { name: string; description: string }> = catalog.metrics;
    return Object.fromEntries(
      Object.entries(metricDefs).map(([entityId, list]) => [entityId, list.map((metric) => ({ ...metric, ...names[metric.id] }))]),
    );
  }, [catalog]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const reportId = searchParams.get('reportId');
  const createChartMutation = useCreateProjectAnalyticsChart();

  const [selectedChart, setSelectedChart] = useState(chartTypes[0]);
  const [chartTitle, setChartTitle] = useState('');
  // Once the user types their own title/description, picking a metric must not overwrite it.
  const [titleEdited, setTitleEdited] = useState(false);
  const [descriptionEdited, setDescriptionEdited] = useState(false);
  const [chartDescription, setChartDescription] = useState('');
  const [selectedEntity, setSelectedEntity] = useState('');
  const [selectedMetric, setSelectedMetric] = useState('');
  const [timeRange, setTimeRange] = useState('last_30_days');
  const [groupBy, setGroupBy] = useState('day');
  const [chartColor, setChartColor] = useState('#3b82f6');
  const [showLegend, setShowLegend] = useState(true);
  const [smoothLines, setSmoothLines] = useState(true);
  const [showDataPoints, setShowDataPoints] = useState(false);
  const [fillArea, setFillArea] = useState(true);
  const [compareWith] = useState('');
  const [aggregation, setAggregation] = useState('sum');
  const [sortOrder, setSortOrder] = useState('asc');
  const [limit, setLimit] = useState('10');

  const handleSave = async () => {
    if (!reportId) {
      router.push('/weldflow/analytics');
      return;
    }

    try {
      await createChartMutation.mutateAsync({
        reportId,
        data: {
          title: chartTitle || catalog.untitledChart,
          description: chartDescription || '',
          chartType: selectedChart.id,
          entity: selectedEntity,
          metric: selectedMetric,
          timeRange,
          groupBy,
          compareWith: compareWith || undefined,
          aggregation,
          sortOrder,
          limit: limit === 'All' ? undefined : Number.parseInt(limit, 10),
          color: chartColor,
          smoothCurve: smoothLines,
          fillArea,
          showDataLabels: showDataPoints,
          showLegend,
        },
      });
      router.push(`/weldflow/analytics/${reportId}`);
    } catch (error) {
      console.error('Failed to create chart:', error);
      toast.error(t.projects.analyticsBuilder.saveChartFailed);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50/50 dark:bg-background/50">

      {/* Center - Preview */}
      <div className="flex-1 flex flex-col relative overflow-visible">
        <div className="w-full h-full flex flex-col overflow-visible">
          {/* Chart Type Selector - Top Left */}
          <div className="absolute top-6 left-6 z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 px-3 bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                  {React.createElement(selectedChart.icon, { className: "h-4 w-4 mr-0.5" })}
                  <span className="text-sm">{selectedChart.name}</span>
                  <ChevronDown className="h-3.5 w-3.5 mr-0.5 text-gray-500" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 shadow-none">
                {chartTypes.map((chart) => {
                  const Icon = chart.icon;
                  const isSelected = selectedChart.id === chart.id;
                  return (
                    <DropdownMenuItem
                      key={chart.id}
                      onClick={() => setSelectedChart(chart)}
                      className={`flex items-center gap-3 py-2 ${isSelected ? 'bg-muted' : ''}`}
                    >
                      <Icon className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                      <div className="flex-1">
                        <p className="text-sm font-medium">{chart.name}</p>
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Preview Label - Top Right */}
          <div className="absolute top-6 right-6 z-10 pointer-events-none">
            <Button variant="secondary" size="sm" className="pointer-events-none">
              {t.projects.analyticsBuilder.preview}
            </Button>
          </div>

          <div className="flex-1 flex items-center justify-center p-8 overflow-visible">
            <div className="w-full max-w-3xl relative z-20 overflow-visible">
                <Card className="border-gray-200/50 dark:border-border/50 shadow-none overflow-visible">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg">{chartTitle || t.projects.analyticsBuilder.chartTitle}</CardTitle>
                    <CardDescription className="text-sm">
                      {chartDescription || t.projects.analyticsBuilder.chartDescription}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="relative overflow-visible">
                    <ChartPreview
                      reportId={reportId}
                      query={{ entity: selectedEntity, metric: selectedMetric, timeRange, groupBy, aggregation, sortOrder, limit: limit === 'All' ? undefined : Number.parseInt(limit, 10) }}
                      chartType={selectedChart.id}
                      color={chartColor}
                      showLegend={showLegend}
                      smoothCurve={smoothLines}
                      fillArea={fillArea}
                      showDataLabels={showDataPoints}
                    />
                  </CardContent>
                </Card>
            </div>
          </div>
        </div>
      </div>

      {/* Right Sidebar - Settings */}
      <div className="w-[360px] bg-white dark:bg-background border-l border-gray-200/50 dark:border-border/50 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 dark:border-border/50 flex-shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-foreground">{t.projects.analyticsBuilder.chartConfiguration}</h2>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => router.push('/weldflow/analytics')}
                variant="outline"
                size="sm"
              >
                {t.projects.analyticsBuilder.close}
              </Button>
              <Button
                onClick={handleSave}
                size="sm"
                disabled={!selectedEntity || !selectedMetric || !chartTitle || !reportId || createChartMutation.isPending}
              >
                {createChartMutation.isPending ? t.projects.analyticsReports.addChartPending : t.projects.analyticsReports.addChart}
              </Button>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-6">
            {/* Basic Information */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.projects.analyticsBuilder.basicInformation}</h3>

              <div className="space-y-5">
                <div>
                  <Label htmlFor="title" className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">
                    {t.projects.analyticsBuilder.titleLabel}
                  </Label>
                  <Input
                    id="title"
                    value={chartTitle}
                    onChange={(e) => {
                      setTitleEdited(true);
                      setChartTitle(e.target.value);
                    }}
                    placeholder={t.projects.analyticsBuilder.titlePlaceholder}
                    className="h-9 text-sm bg-white dark:bg-background border-gray-200 dark:border-border focus:border-gray-300 dark:focus:border-gray-700 transition-colors shadow-none"
                  />
                </div>

                <div>
                  <Label htmlFor="description" className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">
                    {t.projects.analyticsBuilder.descriptionLabel}
                  </Label>
                  <Textarea
                    id="description"
                    value={chartDescription}
                    onChange={(e) => {
                      setDescriptionEdited(true);
                      setChartDescription(e.target.value);
                    }}
                    placeholder={t.projects.analyticsBuilder.descriptionPlaceholder}
                    className="min-h-[60px] text-sm resize-none bg-white dark:bg-background border-gray-200 dark:border-border focus:border-gray-300 dark:focus:border-gray-700 transition-colors shadow-none"
                  />
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-gray-200 dark:bg-secondary"></div>

            {/* Data Source */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.projects.analyticsBuilder.dataSource}</h3>

              <div className="space-y-5">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.entityLabel}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span className="flex items-center gap-2">
                          {selectedEntity ? (
                            <>
                              {React.createElement(entities.find(e => e.id === selectedEntity)?.icon || FolderKanban, { className: "h-3.5 w-3.5 text-gray-500" })}
                              <span>{entities.find(e => e.id === selectedEntity)?.name}</span>
                            </>
                          ) : (
                            <span className="text-gray-500">{t.projects.analyticsBuilder.chooseEntity}</span>
                          )}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {entities.map((entity) => (
                        <DropdownMenuItem
                          key={entity.id}
                          onClick={() => {
                            setSelectedEntity(entity.id);
                            setSelectedMetric('');
                          }}
                          className="flex items-center gap-2 text-sm"
                        >
                          {React.createElement(entity.icon, { className: "h-3.5 w-3.5 text-gray-500" })}
                          <span>{entity.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {selectedEntity && (
                  <div>
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.metricLabel}</Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                          <span>
                            {selectedMetric ?
                              metrics[selectedEntity]?.find(m => m.id === selectedMetric)?.name
                              : t.projects.analyticsBuilder.chooseMetric
                            }
                          </span>
                          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-[300px] overflow-y-auto" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                        {metrics[selectedEntity]?.map((metric) => (
                          <DropdownMenuItem
                            key={metric.id}
                            onClick={() => {
                              setSelectedMetric(metric.id);
                              const entity = entities.find(e => e.id === selectedEntity);
                              if (!titleEdited) setChartTitle(`${entity?.name} - ${metric.name}`);
                              if (!descriptionEdited) setChartDescription(metric.description);
                            }}
                            className="flex flex-col items-start py-2"
                          >
                            <span className="text-sm font-medium">{metric.name}</span>
                            <span className="text-xs text-gray-500">{metric.description}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-gray-200 dark:bg-secondary"></div>

            {/* Time & Grouping */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.projects.analyticsBuilder.timeGrouping}</h3>

              <div className="space-y-5">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.periodLabel}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span>
                          {[
                            { id: 'today', label: t.projects.analyticsBuilder.periods.today },
                            { id: 'yesterday', label: t.projects.analyticsBuilder.periods.yesterday },
                            { id: 'last_7_days', label: t.projects.analyticsBuilder.periods.last7Days },
                            { id: 'last_30_days', label: t.projects.analyticsBuilder.periods.last30Days },
                            { id: 'last_90_days', label: t.projects.analyticsBuilder.periods.last90Days },
                            { id: 'last_year', label: t.projects.analyticsBuilder.periods.lastYear },
                            { id: 'this_month', label: t.projects.analyticsBuilder.periods.thisMonth },
                            { id: 'all_time', label: t.projects.analyticsBuilder.periods.allTime },
                          ].find(r => r.id === timeRange)?.label || t.projects.analyticsBuilder.selectPeriod}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'today', label: t.projects.analyticsBuilder.periods.today },
                        { id: 'yesterday', label: t.projects.analyticsBuilder.periods.yesterday },
                        { id: 'last_7_days', label: t.projects.analyticsBuilder.periods.last7Days },
                        { id: 'last_30_days', label: t.projects.analyticsBuilder.periods.last30Days },
                        { id: 'last_90_days', label: t.projects.analyticsBuilder.periods.last90Days },
                        { id: 'last_year', label: t.projects.analyticsBuilder.periods.lastYear },
                        { id: 'this_month', label: t.projects.analyticsBuilder.periods.thisMonth },
                        { id: 'all_time', label: t.projects.analyticsBuilder.periods.allTime },
                      ].map(range => (
                        <DropdownMenuItem
                          key={range.id}
                          onClick={() => setTimeRange(range.id)}
                          className="text-sm"
                        >
                          {range.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.groupByLabel}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span>
                          {[
                            { id: 'hour', label: t.projects.analyticsBuilder.groupBy.hour },
                            { id: 'day', label: t.projects.analyticsBuilder.groupBy.day },
                            { id: 'week', label: t.projects.analyticsBuilder.groupBy.week },
                            { id: 'month', label: t.projects.analyticsBuilder.groupBy.month },
                            { id: 'quarter', label: t.projects.analyticsBuilder.groupBy.quarter },
                            { id: 'year', label: t.projects.analyticsBuilder.groupBy.year },
                          ].find(g => g.id === groupBy)?.label || t.projects.analyticsBuilder.selectGrouping}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'hour', label: t.projects.analyticsBuilder.groupBy.hour },
                        { id: 'day', label: t.projects.analyticsBuilder.groupBy.day },
                        { id: 'week', label: t.projects.analyticsBuilder.groupBy.week },
                        { id: 'month', label: t.projects.analyticsBuilder.groupBy.month },
                        { id: 'quarter', label: t.projects.analyticsBuilder.groupBy.quarter },
                        { id: 'year', label: t.projects.analyticsBuilder.groupBy.year },
                      ].map(group => (
                        <DropdownMenuItem
                          key={group.id}
                          onClick={() => setGroupBy(group.id)}
                          className="text-sm"
                        >
                          {group.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.calculationLabel}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span className="flex items-center gap-2">
                          {(() => {
                            const agg = [
                              { id: 'sum', label: t.projects.analyticsBuilder.calculations.totalSum, icon: Plus },
                              { id: 'average', label: t.projects.analyticsBuilder.calculations.average, icon: Divide },
                              { id: 'count', label: t.projects.analyticsBuilder.calculations.count, icon: TrendingUp },
                              { id: 'max', label: t.projects.analyticsBuilder.calculations.maximum, icon: ArrowUp },
                              { id: 'min', label: t.projects.analyticsBuilder.calculations.minimum, icon: ArrowDown },
                            ].find(a => a.id === aggregation);
                            return (
                              <>
                                {agg?.icon && React.createElement(agg.icon, { className: "h-3.5 w-3.5 text-gray-500" })}
                                <span>{agg?.label || t.projects.analyticsBuilder.selectCalculation}</span>
                              </>
                            );
                          })()}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'sum', label: t.projects.analyticsBuilder.calculations.totalSum, icon: Plus },
                        { id: 'average', label: t.projects.analyticsBuilder.calculations.average, icon: Divide },
                        { id: 'count', label: t.projects.analyticsBuilder.calculations.count, icon: TrendingUp },
                        { id: 'max', label: t.projects.analyticsBuilder.calculations.maximum, icon: ArrowUp },
                        { id: 'min', label: t.projects.analyticsBuilder.calculations.minimum, icon: ArrowDown },
                      ].map(agg => (
                        <DropdownMenuItem
                          key={agg.id}
                          onClick={() => setAggregation(agg.id)}
                          className="flex items-center gap-2 text-sm"
                        >
                          {React.createElement(agg.icon, { className: "h-3.5 w-3.5 text-gray-500" })}
                          <span>{agg.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-gray-200 dark:bg-secondary"></div>

            {/* Appearance */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.projects.analyticsBuilder.appearance}</h3>

              <div className="space-y-3">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.colorLabel}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span className="flex items-center gap-2">
                          <span
                            className="w-3.5 h-3.5 rounded border border-gray-300"
                            style={{ backgroundColor: chartColor }}
                          />
                          <span>
                            {(() => {
                              const colors = [
                                { value: '#3b82f6', name: t.projects.analyticsBuilder.colors.blue },
                                { value: '#10b981', name: t.projects.analyticsBuilder.colors.green },
                                { value: '#8b5cf6', name: t.projects.analyticsBuilder.colors.purple },
                                { value: '#f59e0b', name: t.projects.analyticsBuilder.colors.amber },
                                { value: '#ec4899', name: t.projects.analyticsBuilder.colors.pink },
                                { value: '#ef4444', name: t.projects.analyticsBuilder.colors.red },
                                { value: '#06b6d4', name: t.projects.analyticsBuilder.colors.cyan },
                                { value: '#84cc16', name: t.projects.analyticsBuilder.colors.lime },
                              ];
                              return colors.find(c => c.value === chartColor)?.name || t.projects.analyticsBuilder.colors.custom;
                            })()}
                          </span>
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { value: '#3b82f6', name: t.projects.analyticsBuilder.colors.blue },
                        { value: '#10b981', name: t.projects.analyticsBuilder.colors.green },
                        { value: '#8b5cf6', name: t.projects.analyticsBuilder.colors.purple },
                        { value: '#f59e0b', name: t.projects.analyticsBuilder.colors.amber },
                        { value: '#ec4899', name: t.projects.analyticsBuilder.colors.pink },
                        { value: '#ef4444', name: t.projects.analyticsBuilder.colors.red },
                        { value: '#06b6d4', name: t.projects.analyticsBuilder.colors.cyan },
                        { value: '#84cc16', name: t.projects.analyticsBuilder.colors.lime },
                      ].map(color => (
                        <DropdownMenuItem
                          key={color.value}
                          onClick={() => setChartColor(color.value)}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span
                            className="w-3.5 h-3.5 rounded border border-gray-300"
                            style={{ backgroundColor: color.value }}
                          />
                          <span>{color.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div className="space-y-4 mt-5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.projects.analyticsBuilder.smoothLines}</Label>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <span className="sr-only">{t.projects.analyticsBuilder.smoothLines}</span>
                      <input
                        type="checkbox"
                        checked={smoothLines}
                        onChange={(e) => setSmoothLines(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                      <div className="absolute left-[3px] top-[3px] bg-white w-[10px] h-[10px] rounded-full transition-transform peer-checked:translate-x-3"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.projects.analyticsBuilder.fillArea}</Label>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <span className="sr-only">{t.projects.analyticsBuilder.fillArea}</span>
                      <input
                        type="checkbox"
                        checked={fillArea}
                        onChange={(e) => setFillArea(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                      <div className="absolute left-[3px] top-[3px] bg-white w-[10px] h-[10px] rounded-full transition-transform peer-checked:translate-x-3"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.projects.analyticsBuilder.showDataPoints}</Label>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <span className="sr-only">{t.projects.analyticsBuilder.showDataPoints}</span>
                      <input
                        type="checkbox"
                        checked={showDataPoints}
                        onChange={(e) => setShowDataPoints(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                      <div className="absolute left-[3px] top-[3px] bg-white w-[10px] h-[10px] rounded-full transition-transform peer-checked:translate-x-3"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.projects.analyticsBuilder.showLegend}</Label>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <span className="sr-only">{t.projects.analyticsBuilder.showLegend}</span>
                      <input
                        type="checkbox"
                        checked={showLegend}
                        onChange={(e) => setShowLegend(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                      <div className="absolute left-[3px] top-[3px] bg-white w-[10px] h-[10px] rounded-full transition-transform peer-checked:translate-x-3"></div>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-gray-200 dark:bg-secondary"></div>

            {/* Data Options */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.projects.analyticsBuilder.dataOptions}</h3>

              <div className="space-y-5">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.sortOrderLabel}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span className="flex items-center gap-2">
                          {(() => {
                            const sort = [
                              { id: 'asc', label: t.projects.analyticsBuilder.sortOrders.ascending, icon: SortAsc },
                              { id: 'desc', label: t.projects.analyticsBuilder.sortOrders.descending, icon: SortDesc },
                            ].find(s => s.id === sortOrder);
                            return (
                              <>
                                {sort?.icon && React.createElement(sort.icon, { className: "h-3.5 w-3.5 text-gray-500" })}
                                <span>{sort?.label || t.projects.analyticsBuilder.selectOrder}</span>
                              </>
                            );
                          })()}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'asc', label: t.projects.analyticsBuilder.sortOrders.ascending, icon: SortAsc },
                        { id: 'desc', label: t.projects.analyticsBuilder.sortOrders.descending, icon: SortDesc },
                      ].map(sort => (
                        <DropdownMenuItem
                          key={sort.id}
                          onClick={() => setSortOrder(sort.id)}
                          className="flex items-center gap-2 text-sm"
                        >
                          {React.createElement(sort.icon, { className: "h-3.5 w-3.5 text-gray-500" })}
                          <span>{sort.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.projects.analyticsBuilder.maximumItems}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span>{limit === 'All' ? t.projects.analyticsBuilder.showAll : t.projects.analyticsBuilder.items.replace('{count}', limit)}</span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {['5', '10', '25', '50', '100', 'All'].map(num => (
                        <DropdownMenuItem
                          key={num}
                          onClick={() => setLimit(num)}
                          className="text-sm"
                        >
                          {num === 'All' ? t.projects.analyticsBuilder.showAll : t.projects.analyticsBuilder.items.replace('{count}', num)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
