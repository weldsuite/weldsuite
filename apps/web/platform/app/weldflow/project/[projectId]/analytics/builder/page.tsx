
import React, { useState, useTransition } from 'react';
import { useRouter, useSearchParams, useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
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
  Area,
  AreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Pie,
  PieChart as RechartsPieChart,
  Label as RechartsLabel,
  XAxis,
} from "recharts"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@weldsuite/ui/components/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@weldsuite/ui/components/chart"

const chartData = [
  { month: "January", desktop: 186 },
  { month: "February", desktop: 305 },
  { month: "March", desktop: 237 },
  { month: "April", desktop: 73 },
  { month: "May", desktop: 209 },
  { month: "June", desktop: 214 },
]

const multiSeriesData = [
  { month: "January", desktop: 186, mobile: 80 },
  { month: "February", desktop: 305, mobile: 200 },
  { month: "March", desktop: 237, mobile: 120 },
  { month: "April", desktop: 73, mobile: 190 },
  { month: "May", desktop: 209, mobile: 130 },
  { month: "June", desktop: 214, mobile: 140 },
]

const mixedBarChartData = [
  { browser: "chrome", visitors: 275, fill: "var(--chart-1)" },
  { browser: "safari", visitors: 200, fill: "var(--chart-2)" },
  { browser: "firefox", visitors: 187, fill: "var(--chart-3)" },
  { browser: "edge", visitors: 173, fill: "var(--chart-4)" },
  { browser: "other", visitors: 90, fill: "var(--chart-5)" },
]

const chartTypes = [
  { id: 'area-chart', name: 'Area Chart', icon: AreaChartIcon },
  { id: 'area-linear', name: 'Area Chart - Linear', icon: AreaChartIcon },
  { id: 'area-stacked', name: 'Area Chart - Stacked', icon: Layers },
  { id: 'bar-multiple', name: 'Bar Chart - Multiple', icon: BarChart3 },
  { id: 'bar-mixed', name: 'Bar Chart - Mixed', icon: BarChart3 },
  { id: 'bar-stacked', name: 'Bar Chart - Stacked', icon: Layers },
  { id: 'bar-negative', name: 'Bar Chart - Negative', icon: TrendingUpDown },
  { id: 'pie-label', name: 'Pie Chart - Label', icon: PieChart },
  { id: 'pie-donut', name: 'Pie Chart - Donut', icon: Activity },
  { id: 'radar-lines', name: 'Radar Chart', icon: Activity },
  { id: 'radial-simple', name: 'Radial Chart', icon: Activity },
  { id: 'radial-text', name: 'Radial Chart - Text', icon: Activity },
];

const entities = [
  { id: 'projects', name: 'Projects', icon: FolderKanban },
  { id: 'tasks', name: 'Tasks', icon: CheckSquare },
  { id: 'time_entries', name: 'Time Entries', icon: Clock },
  { id: 'milestones', name: 'Milestones', icon: Target },
];

const metrics: Record<string, Array<{ id: string; name: string; description: string }>> = {
  projects: [
    { id: 'total_projects', name: 'Total Projects', description: 'Number of all projects' },
    { id: 'active_projects', name: 'Active Projects', description: 'Currently active projects' },
    { id: 'projects_by_status', name: 'Projects by Status', description: 'Breakdown by status' },
    { id: 'projects_by_health', name: 'Projects by Health', description: 'On Track/At Risk/Off Track' },
    { id: 'completion_rate', name: 'Completion Rate', description: 'Task completion percentage' },
    { id: 'budget_utilization', name: 'Budget Utilization', description: 'Actual vs budgeted amount' },
    { id: 'hours_utilization', name: 'Hours Utilization', description: 'Actual vs budgeted hours' },
    { id: 'avg_progress', name: 'Average Progress', description: 'Mean project progress' },
  ],
  tasks: [
    { id: 'total_tasks', name: 'Total Tasks', description: 'Number of all tasks' },
    { id: 'completed_tasks', name: 'Completed Tasks', description: 'Tasks marked as done' },
    { id: 'overdue_tasks', name: 'Overdue Tasks', description: 'Tasks past due date' },
    { id: 'tasks_by_status', name: 'Tasks by Status', description: 'Breakdown by status' },
    { id: 'tasks_by_priority', name: 'Tasks by Priority', description: 'Critical/High/Medium/Low' },
    { id: 'tasks_by_type', name: 'Tasks by Type', description: 'Task/Bug/Story/Epic' },
    { id: 'throughput', name: 'Throughput', description: 'Tasks completed per period' },
    { id: 'estimation_accuracy', name: 'Estimation Accuracy', description: 'Actual vs estimated hours' },
  ],
  time_entries: [
    { id: 'total_hours', name: 'Total Hours', description: 'Sum of all logged hours' },
    { id: 'billable_hours', name: 'Billable Hours', description: 'Hours marked as billable' },
    { id: 'non_billable_hours', name: 'Non-Billable Hours', description: 'Hours not billable' },
    { id: 'utilization_rate', name: 'Utilization Rate', description: 'Billable percentage' },
    { id: 'total_cost', name: 'Total Cost', description: 'Sum of time entry costs' },
  ],
  milestones: [
    { id: 'total_milestones', name: 'Total Milestones', description: 'Number of all milestones' },
    { id: 'milestones_by_status', name: 'Milestones by Status', description: 'Breakdown by status' },
    { id: 'completed_milestones', name: 'Completed Milestones', description: 'Milestones marked done' },
    { id: 'overdue_milestones', name: 'Overdue Milestones', description: 'Milestones past due' },
    { id: 'on_time_milestones', name: 'On Time Milestones', description: 'Completed on schedule' },
    { id: 'avg_milestone_progress', name: 'Average Progress', description: 'Mean milestone progress' },
  ],
};

export default function ProjectAnalyticsBuilderPage() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const reportId = searchParams.get('reportId');
  const [isPending, startTransition] = useTransition();

  const basePath = `/weldflow/project/${projectId}/analytics`;

  const [selectedChart, setSelectedChart] = useState(chartTypes[0]);
  const [chartTitle, setChartTitle] = useState('');
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

  const chartConfig = {
    desktop: { label: "Value", color: chartColor },
    mobile: { label: "Mobile", color: "#93c5fd" },
    visitors: { label: "Visitors", color: chartColor },
    chrome: { label: "Chrome", color: "#3b82f6" },
    safari: { label: "Safari", color: "#93c5fd" },
    firefox: { label: "Firefox", color: "#60a5fa" },
    edge: { label: "Edge", color: "#2563eb" },
    other: { label: "Other", color: "#1d4ed8" },
  } satisfies ChartConfig;

  const handleSave = async () => {
    if (!reportId) {
      router.push(basePath);
      return;
    }

    startTransition(async () => {
      try {
        const result = await analyticsApi.createChart(reportId, {
          title: chartTitle || 'Untitled Chart',
          description: chartDescription || '',
          chartType: selectedChart.id,
          entity: selectedEntity,
          metric: selectedMetric,
          timeRange,
          groupBy,
          aggregation,
          sortOrder,
          limit: limit === 'All' ? undefined : parseInt(limit, 10),
          color: chartColor,
          smoothCurve: smoothLines,
          fillArea,
          showDataLabels: showDataPoints,
          showLegend,
        });

        if (result.success) {
          router.push(`${basePath}/${reportId}`);
        }
      } catch (error) {
        console.error('Failed to create chart:', error);
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
                  <ChartContainer config={chartConfig}>
                    {selectedChart.id === 'area-chart' && (
                      <AreaChart data={chartData} margin={{ left: 12, right: 12 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => typeof v === 'string' ? v.slice(0, 3) : String(v)} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Area dataKey="desktop" type={smoothLines ? "natural" : "linear"} fill={fillArea ? chartColor : "transparent"} fillOpacity={fillArea ? 0.2 : 0} stroke={chartColor} strokeWidth={2} dot={showDataPoints} />
                      </AreaChart>
                    )}
                    {selectedChart.id === 'bar-multiple' && (
                      <RechartsBarChart data={multiSeriesData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="month" tickLine={false} tickMargin={10} axisLine={false} tickFormatter={(v) => typeof v === 'string' ? v.slice(0, 3) : String(v)} />
                        <ChartTooltip content={<ChartTooltipContent indicator="dashed" />} />
                        <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
                        <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
                      </RechartsBarChart>
                    )}
                    {selectedChart.id === 'pie-donut' && (
                      <RechartsPieChart>
                        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                        <Pie data={mixedBarChartData} dataKey="visitors" nameKey="browser" innerRadius={60} strokeWidth={5}>
                          <RechartsLabel content={({ viewBox }) => {
                            if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                              const total = mixedBarChartData.reduce((a, c) => a + c.visitors, 0);
                              return (<text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle"><tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-3xl font-bold">{total}</tspan><tspan x={viewBox.cx} y={(viewBox.cy || 0) + 24} className="fill-muted-foreground">{t.projects.analyticsBuilder.total}</tspan></text>);
                            }
                          }} />
                        </Pie>
                      </RechartsPieChart>
                    )}
                    {/* Simplified preview for other chart types */}
                    {!['area-chart', 'bar-multiple', 'pie-donut'].includes(selectedChart.id) && (
                      <RechartsBarChart data={chartData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => typeof v === 'string' ? v.slice(0, 3) : String(v)} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="desktop" fill={chartColor} radius={4} />
                      </RechartsBarChart>
                    )}
                  </ChartContainer>
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
                <Input id="title" value={chartTitle} onChange={(e) => setChartTitle(e.target.value)} placeholder={t.projects.analyticsBuilder.titlePlaceholder} className="h-9 text-sm" />
              </div>
              <div>
                <Label htmlFor="description" className="text-xs mb-1.5 block">{t.projects.analyticsBuilder.descriptionLabel}</Label>
                <Textarea id="description" value={chartDescription} onChange={(e) => setChartDescription(e.target.value)} placeholder={t.projects.analyticsBuilder.descriptionPlaceholder} className="min-h-[60px] text-sm resize-none" />
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
                        <DropdownMenuItem key={metric.id} onClick={() => { setSelectedMetric(metric.id); const entity = entities.find(e => e.id === selectedEntity); setChartTitle(`${entity?.name} - ${metric.name}`); setChartDescription(metric.description); }} className="flex flex-col items-start py-2">
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
