
import React, { useState, useTransition } from 'react';
import { useRouter, useSearchParams, useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import { analyticsApi } from '@/app/weldflow/lib/api-client';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  ChevronDown, BarChart3, PieChart, Activity,
  AreaChart as AreaChartIcon, Layers, FolderKanban, CheckSquare, Clock,
  Target, TrendingUpDown
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
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
  { id: 'area-chart', icon: AreaChartIcon },
  { id: 'area-linear', icon: AreaChartIcon },
  { id: 'area-stacked', icon: Layers },
  { id: 'bar-multiple', icon: BarChart3 },
  { id: 'bar-mixed', icon: BarChart3 },
  { id: 'bar-stacked', icon: Layers },
  { id: 'bar-negative', icon: TrendingUpDown },
  { id: 'pie-label', icon: PieChart },
  { id: 'pie-donut', icon: Activity },
  { id: 'radar-lines', icon: Activity },
  { id: 'radial-simple', icon: Activity },
  { id: 'radial-text', icon: Activity },
];

const entityDefs = [
  { id: 'projects', icon: FolderKanban },
  { id: 'tasks', icon: CheckSquare },
  { id: 'time_entries', icon: Clock },
  { id: 'milestones', icon: Target },
];

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
  ],
  time_entries: [
    { id: 'total_hours' },
    { id: 'billable_hours' },
    { id: 'non_billable_hours' },
    { id: 'utilization_rate' },
    { id: 'total_cost' },
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

export default function ProjectAnalyticsBuilderPage() {
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
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const reportId = searchParams.get('reportId');
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();

  const basePath = `/weldflow/project/${projectId}/analytics`;

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
  const [aggregation] = useState('sum');
  const [sortOrder] = useState('asc');
  const [limit] = useState('10');

  const handleSave = () => {
    if (!reportId) {
      router.push(basePath);
      return;
    }

    startTransition(async () => {
      try {
        const result = await analyticsApi.createChart(reportId, {
          title: chartTitle || catalog.untitledChart,
          description: chartDescription || '',
          chartType: selectedChart.id,
          entity: selectedEntity,
          metric: selectedMetric,
          timeRange,
          groupBy,
          aggregation,
          sortOrder,
          limit: limit === 'All' ? undefined : Number.parseInt(limit, 10),
          color: chartColor,
          smoothCurve: smoothLines,
          fillArea,
          showDataLabels: showDataPoints,
          showLegend,
        });

        if (result.success) {
          void queryClient.invalidateQueries({ queryKey: projectKeys.analyticsCharts(reportId) });
          void queryClient.invalidateQueries({ queryKey: projectKeys.analyticsReport(reportId) });
          void queryClient.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
          router.push(`${basePath}/${reportId}`);
        } else {
          toast.error(result.error || t.projects.analyticsBuilder.saveChartFailed);
        }
      } catch (error) {
        console.error('Failed to create chart:', error);
        toast.error(t.projects.analyticsBuilder.saveChartFailed);
      }
    });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50/50 dark:bg-background/50">
      {/* Center - Preview */}
      <div className="flex-1 flex flex-col relative overflow-visible">
        <div className="w-full h-full flex flex-col overflow-visible">
          <div className="absolute top-6 left-6 z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 px-3 bg-white dark:bg-background border-gray-200 dark:border-border">
                  {React.createElement(selectedChart.icon, { className: "h-4 w-4 mr-0.5" })}
                  <span className="text-sm">{selectedChart.name}</span>
                  <ChevronDown className="h-3.5 w-3.5 ml-1 text-gray-500" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {chartTypes.map((chart) => {
                  const Icon = chart.icon;
                  return (
                    <DropdownMenuItem key={chart.id} onClick={() => setSelectedChart(chart)} className="flex items-center gap-3 py-2">
                      <Icon className="h-4 w-4 text-gray-600" />
                      <span className="text-sm font-medium">{chart.name}</span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="absolute top-6 right-6 z-10">
            <Button variant="secondary" size="sm" className="pointer-events-none">{t.projects.analyticsBuilder.preview}</Button>
          </div>

          <div className="flex-1 flex items-center justify-center p-8">
            <div className="w-full max-w-3xl">
              <Card className="border-gray-200/50 dark:border-border/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">{chartTitle || t.projects.analyticsBuilder.chartTitle}</CardTitle>
                  <CardDescription className="text-sm">{chartDescription || t.projects.analyticsBuilder.chartDescription}</CardDescription>
                </CardHeader>
                <CardContent>
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

      {/* Right Sidebar */}
      <div className="w-[360px] bg-white dark:bg-background border-l flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b flex-shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t.projects.analyticsBuilder.chartConfiguration}</h2>
            <div className="flex items-center gap-2">
              <Button onClick={() => router.push(basePath)} variant="outline" size="sm">{t.projects.analyticsBuilder.close}</Button>
              <Button onClick={handleSave} size="sm" disabled={!selectedEntity || !selectedMetric || !chartTitle || !reportId || isPending}>
                {isPending ? t.projects.analyticsReports.addChartPending : t.projects.analyticsReports.addChart}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase">{t.projects.analyticsBuilder.basicInformation}</h3>
            <div className="space-y-4">
              <div>
                <Label htmlFor="title" className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.titleLabel}</Label>
                <Input id="title" value={chartTitle} onChange={(e) => { setTitleEdited(true); setChartTitle(e.target.value); }} placeholder={t.projects.analyticsBuilder.titlePlaceholder} className="h-9 text-sm" />
              </div>
              <div>
                <Label htmlFor="description" className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.descriptionLabel}</Label>
                <Textarea id="description" value={chartDescription} onChange={(e) => { setDescriptionEdited(true); setChartDescription(e.target.value); }} placeholder={t.projects.analyticsBuilder.descriptionPlaceholder} className="min-h-[60px] text-sm resize-none" />
              </div>
            </div>
          </div>

          <div className="h-px bg-gray-200 dark:bg-secondary" />

          {/* Data Source */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase">{t.projects.analyticsBuilder.dataSource}</h3>
            <div className="space-y-4">
              <div>
                <Label className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.entityLabel}</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full h-9 justify-between text-sm">
                      <span className="flex items-center gap-2">
                        {selectedEntity ? (<>{React.createElement(entities.find(e => e.id === selectedEntity)?.icon || FolderKanban, { className: "h-3.5 w-3.5" })}<span>{entities.find(e => e.id === selectedEntity)?.name}</span></>) : (<span className="text-gray-500">{t.projects.analyticsBuilder.chooseEntity}</span>)}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                    {entities.map((entity) => (<DropdownMenuItem key={entity.id} onClick={() => { setSelectedEntity(entity.id); setSelectedMetric(''); }} className="flex items-center gap-2 text-sm">{React.createElement(entity.icon, { className: "h-3.5 w-3.5" })}<span>{entity.name}</span></DropdownMenuItem>))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {selectedEntity && (
                <div>
                  <Label className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.metricLabel}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm">
                        <span>{selectedMetric ? metrics[selectedEntity]?.find(m => m.id === selectedMetric)?.name : t.projects.analyticsBuilder.chooseMetric}</span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-[300px] overflow-y-auto" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {metrics[selectedEntity]?.map((metric) => (
                        <DropdownMenuItem key={metric.id} onClick={() => { setSelectedMetric(metric.id); const entity = entities.find(e => e.id === selectedEntity); if (!titleEdited) setChartTitle(`${entity?.name} - ${metric.name}`); if (!descriptionEdited) setChartDescription(metric.description); }} className="flex flex-col items-start py-2">
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

          <div className="h-px bg-gray-200 dark:bg-secondary" />

          {/* Time & Grouping */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase">{t.projects.analyticsBuilder.timeGrouping}</h3>
            <div className="space-y-4">
              <div>
                <Label className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.periodLabel}</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full h-9 justify-between text-sm">
                      <span>{[{ id: 'today', label: t.projects.analyticsBuilder.periods.today }, { id: 'last_7_days', label: t.projects.analyticsBuilder.periods.last7Days }, { id: 'last_30_days', label: t.projects.analyticsBuilder.periods.last30Days }, { id: 'last_90_days', label: t.projects.analyticsBuilder.periods.last90Days }, { id: 'this_month', label: t.projects.analyticsBuilder.periods.thisMonth }, { id: 'all_time', label: t.projects.analyticsBuilder.periods.allTime }].find(r => r.id === timeRange)?.label}</span>
                      <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                    {[{ id: 'today', label: t.projects.analyticsBuilder.periods.today }, { id: 'last_7_days', label: t.projects.analyticsBuilder.periods.last7Days }, { id: 'last_30_days', label: t.projects.analyticsBuilder.periods.last30Days }, { id: 'last_90_days', label: t.projects.analyticsBuilder.periods.last90Days }, { id: 'this_month', label: t.projects.analyticsBuilder.periods.thisMonth }, { id: 'all_time', label: t.projects.analyticsBuilder.periods.allTime }].map(r => (<DropdownMenuItem key={r.id} onClick={() => setTimeRange(r.id)} className="text-sm">{r.label}</DropdownMenuItem>))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div>
                <Label className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.groupByLabel}</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full h-9 justify-between text-sm">
                      <span>{[{ id: 'hour', label: t.projects.analyticsBuilder.groupBy.hour }, { id: 'day', label: t.projects.analyticsBuilder.groupBy.day }, { id: 'week', label: t.projects.analyticsBuilder.groupBy.week }, { id: 'month', label: t.projects.analyticsBuilder.groupBy.month }].find(g => g.id === groupBy)?.label}</span>
                      <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                    {[{ id: 'hour', label: t.projects.analyticsBuilder.groupBy.hour }, { id: 'day', label: t.projects.analyticsBuilder.groupBy.day }, { id: 'week', label: t.projects.analyticsBuilder.groupBy.week }, { id: 'month', label: t.projects.analyticsBuilder.groupBy.month }].map(g => (<DropdownMenuItem key={g.id} onClick={() => setGroupBy(g.id)} className="text-sm">{g.label}</DropdownMenuItem>))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          <div className="h-px bg-gray-200 dark:bg-secondary" />

          {/* Appearance */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase">{t.projects.analyticsBuilder.appearance}</h3>
            <div>
              <Label className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.colorLabel}</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full h-9 justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <span className="w-3.5 h-3.5 rounded border" style={{ backgroundColor: chartColor }} />
                      <span>{[{ value: '#3b82f6', name: t.projects.analyticsBuilder.colors.blue }, { value: '#10b981', name: t.projects.analyticsBuilder.colors.green }, { value: '#8b5cf6', name: t.projects.analyticsBuilder.colors.purple }, { value: '#f59e0b', name: t.projects.analyticsBuilder.colors.amber }, { value: '#ef4444', name: t.projects.analyticsBuilder.colors.red }].find(c => c.value === chartColor)?.name || t.projects.analyticsBuilder.colors.custom}</span>
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                  {[{ value: '#3b82f6', name: t.projects.analyticsBuilder.colors.blue }, { value: '#10b981', name: t.projects.analyticsBuilder.colors.green }, { value: '#8b5cf6', name: t.projects.analyticsBuilder.colors.purple }, { value: '#f59e0b', name: t.projects.analyticsBuilder.colors.amber }, { value: '#ef4444', name: t.projects.analyticsBuilder.colors.red }, { value: '#06b6d4', name: t.projects.analyticsBuilder.colors.cyan }].map(c => (<DropdownMenuItem key={c.value} onClick={() => setChartColor(c.value)} className="flex items-center gap-2 text-sm"><span className="w-3.5 h-3.5 rounded border" style={{ backgroundColor: c.value }} /><span>{c.name}</span></DropdownMenuItem>))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="space-y-3">
              {[{ label: t.projects.analyticsBuilder.smoothLines, checked: smoothLines, onChange: setSmoothLines }, { label: t.projects.analyticsBuilder.fillArea, checked: fillArea, onChange: setFillArea }, { label: t.projects.analyticsBuilder.showDataPoints, checked: showDataPoints, onChange: setShowDataPoints }, { label: t.projects.analyticsBuilder.showLegend, checked: showLegend, onChange: setShowLegend }].map((opt) => (
                <div key={opt.label} className="flex items-center justify-between">
                  <Label className="text-xs">{opt.label}</Label>
                  <Switch checked={opt.checked} onCheckedChange={opt.onChange} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
