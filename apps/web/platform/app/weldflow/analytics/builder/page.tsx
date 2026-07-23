
import React, { useState } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useCreateAnalyticsChart } from '@/hooks/queries/use-projects-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  ChevronDown, BarChart3, LineChart, PieChart, Activity, TrendingUp,
  AreaChart as AreaChartIcon, Layers, FolderKanban, CheckSquare, Clock,
  Target, Plus, Divide, ArrowUp, ArrowDown, TrendingUpDown, SortAsc, SortDesc, X
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
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
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Cell,
  Label as RechartsLabel,
  LabelList,
  XAxis,
  YAxis
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
  ChartLegend,
  ChartLegendContent,
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

const negativeBarChartData = [
  { month: "January", visitors: 186 },
  { month: "February", visitors: 205 },
  { month: "March", visitors: -207 },
  { month: "April", visitors: 173 },
  { month: "May", visitors: -209 },
  { month: "June", visitors: 214 },
]

const chartTypes = [
  {
    id: 'area-chart',
    name: 'Area Chart',
    icon: AreaChartIcon,
    description: 'Display trends over time with filled areas',
  },
  {
    id: 'area-linear',
    name: 'Area Chart - Linear',
    icon: AreaChartIcon,
    description: 'Linear area chart with dot indicator',
  },
  {
    id: 'area-stacked',
    name: 'Area Chart - Stacked',
    icon: Layers,
    description: 'Stacked area chart showing cumulative values',
  },
  {
    id: 'bar-multiple',
    name: 'Bar Chart - Multiple',
    icon: BarChart3,
    description: 'Multiple bar chart for comparing values',
  },
  {
    id: 'bar-mixed',
    name: 'Bar Chart - Mixed',
    icon: BarChart3,
    description: 'Horizontal bar chart with mixed colors',
  },
  {
    id: 'bar-stacked',
    name: 'Bar Chart - Stacked',
    icon: Layers,
    description: 'Stacked bar chart with legend',
  },
  {
    id: 'bar-negative',
    name: 'Bar Chart - Negative',
    icon: TrendingUpDown,
    description: 'Bar chart with negative values',
  },
  {
    id: 'pie-label',
    name: 'Pie Chart - Label',
    icon: PieChart,
    description: 'Pie chart with label list',
  },
  {
    id: 'pie-donut',
    name: 'Pie Chart - Donut',
    icon: Activity,
    description: 'Donut chart with center text',
  },
  {
    id: 'radar-lines',
    name: 'Radar Chart - Lines Only',
    icon: Activity,
    description: 'Radar chart with lines only',
  },
  {
    id: 'radial-simple',
    name: 'Radial Chart',
    icon: Activity,
    description: 'Simple radial bar chart',
  },
  {
    id: 'radial-text',
    name: 'Radial Chart - Text',
    icon: Activity,
    description: 'Radial chart with center text',
  },
];

// Projects-specific entities
const entities = [
  { id: 'projects', name: 'Projects', icon: FolderKanban },
  { id: 'tasks', name: 'Tasks', icon: CheckSquare },
  { id: 'time_entries', name: 'Time Entries', icon: Clock },
  { id: 'milestones', name: 'Milestones', icon: Target },
];

// Projects-specific metrics
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
    { id: 'projects_by_day', name: 'Projects by Day', description: 'Daily project count' },
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
    { id: 'tasks_by_day', name: 'Tasks by Day', description: 'Daily task count' },
  ],
  time_entries: [
    { id: 'total_hours', name: 'Total Hours', description: 'Sum of all logged hours' },
    { id: 'billable_hours', name: 'Billable Hours', description: 'Hours marked as billable' },
    { id: 'non_billable_hours', name: 'Non-Billable Hours', description: 'Hours not billable' },
    { id: 'utilization_rate', name: 'Utilization Rate', description: 'Billable percentage' },
    { id: 'total_cost', name: 'Total Cost', description: 'Sum of time entry costs' },
    { id: 'hours_by_day', name: 'Hours by Day', description: 'Daily hours tracking' },
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

export default function ProjectsAnalyticsBuilderPage() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const reportId = searchParams.get('reportId');
  const createChartMutation = useCreateAnalyticsChart();

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
  const [compareWith, setCompareWith] = useState('');
  const [aggregation, setAggregation] = useState('sum');
  const [sortOrder, setSortOrder] = useState('asc');
  const [limit, setLimit] = useState('10');

  // Dynamic chart config based on selected color
  const chartConfig = {
    desktop: {
      label: "Value",
      color: chartColor,
    },
    mobile: {
      label: "Mobile",
      color: "#93c5fd",
    },
    visitors: {
      label: "Visitors",
      color: chartColor,
    },
    chrome: {
      label: "Chrome",
      color: "#3b82f6",
    },
    safari: {
      label: "Safari",
      color: "#93c5fd",
    },
    firefox: {
      label: "Firefox",
      color: "#60a5fa",
    },
    edge: {
      label: "Edge",
      color: "#2563eb",
    },
    other: {
      label: "Other",
      color: "#1d4ed8",
    },
  } satisfies ChartConfig;

  const handleSave = async () => {
    if (!reportId) {
      router.push('/weldflow/analytics');
      return;
    }

    try {
      await createChartMutation.mutateAsync({
        reportId,
        data: {
          title: chartTitle || 'Untitled Chart',
          description: chartDescription || '',
          chartType: selectedChart.id,
          entity: selectedEntity,
          metric: selectedMetric,
          timeRange,
          groupBy,
          compareWith: compareWith || undefined,
          aggregation,
          sortOrder,
          limit: limit === 'All' ? undefined : parseInt(limit, 10),
          color: chartColor,
          smoothCurve: smoothLines,
          fillArea,
          showDataLabels: showDataPoints,
          showLegend,
        },
      });
      router.push(`/weldflow/analytics/${reportId}`);
    } catch (error) {
      // Error handled by mutation
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
                    <ChartContainer config={chartConfig} className="relative z-10 overflow-visible">
                      {selectedChart.id === 'area-chart' && (
                        <AreaChart
                          accessibilityLayer
                          data={chartData}
                          margin={{ left: 12, right: 12 }}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="month"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 3) : String(value)}
                          />
                          <ChartTooltip
                            cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent labelFormatter={(value) => String(value)} />}
                          />
                          <Area
                            dataKey="desktop"
                            type={smoothLines ? "natural" : "linear"}
                            fill={fillArea ? chartColor : "transparent"}
                            fillOpacity={fillArea ? 0.2 : 0}
                            stroke={chartColor}
                            strokeWidth={2}
                            dot={showDataPoints}
                          />
                        </AreaChart>
                      )}

                      {selectedChart.id === 'area-linear' && (
                        <AreaChart
                          accessibilityLayer
                          data={chartData}
                          margin={{ left: 12, right: 12 }}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="month"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 3) : String(value)}
                          />
                          <ChartTooltip
                            cursor={false}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent indicator="dot" labelKey="month" />}
                          />
                          <Area
                            dataKey="desktop"
                            type="linear"
                            fill={chartColor}
                            fillOpacity={0.4}
                            stroke={chartColor}
                          />
                        </AreaChart>
                      )}

                      {selectedChart.id === 'area-stacked' && (
                        <AreaChart
                          accessibilityLayer
                          data={multiSeriesData}
                          margin={{ left: 12, right: 12 }}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="month"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 3) : String(value)}
                          />
                          <ChartTooltip
                            cursor={false}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent indicator="dot" labelKey="month" />}
                          />
                          <Area
                            dataKey="mobile"
                            type="natural"
                            fill="var(--color-mobile)"
                            fillOpacity={0.4}
                            stroke="var(--color-mobile)"
                            stackId="a"
                          />
                          <Area
                            dataKey="desktop"
                            type="natural"
                            fill="var(--color-desktop)"
                            fillOpacity={0.4}
                            stroke="var(--color-desktop)"
                            stackId="a"
                          />
                        </AreaChart>
                      )}

                      {selectedChart.id === 'bar-multiple' && (
                        <RechartsBarChart accessibilityLayer data={multiSeriesData}>
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="month"
                            tickLine={false}
                            tickMargin={10}
                            axisLine={false}
                            tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 3) : String(value)}
                          />
                          <ChartTooltip
                            cursor={false}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent indicator="dashed" />}
                          />
                          <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
                          <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
                        </RechartsBarChart>
                      )}

                      {selectedChart.id === 'bar-mixed' && (
                        <RechartsBarChart
                          accessibilityLayer
                          data={mixedBarChartData}
                          layout="vertical"
                          margin={{ left: 0 }}
                        >
                          <YAxis
                            dataKey="browser"
                            type="category"
                            tickLine={false}
                            tickMargin={10}
                            axisLine={false}
                            tickFormatter={(value) =>
                              chartConfig[value as keyof typeof chartConfig]?.label || value
                            }
                          />
                          <XAxis dataKey="visitors" type="number" hide />
                          <ChartTooltip
                            cursor={false}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent hideLabel />}
                          />
                          <Bar dataKey="visitors" radius={5} />
                        </RechartsBarChart>
                      )}

                      {selectedChart.id === 'bar-stacked' && (
                        <RechartsBarChart accessibilityLayer data={multiSeriesData}>
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="month"
                            tickLine={false}
                            tickMargin={10}
                            axisLine={false}
                            tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 3) : String(value)}
                          />
                          <ChartTooltip
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent hideLabel />}
                          />
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          <ChartLegend content={(props: any) => <ChartLegendContent {...props} />} />
                          <Bar
                            dataKey="desktop"
                            stackId="a"
                            fill="var(--color-desktop)"
                            radius={[0, 0, 4, 4]}
                          />
                          <Bar
                            dataKey="mobile"
                            stackId="a"
                            fill="var(--color-mobile)"
                            radius={[4, 4, 0, 0]}
                          />
                        </RechartsBarChart>
                      )}

                      {selectedChart.id === 'bar-negative' && (
                        <RechartsBarChart accessibilityLayer data={negativeBarChartData}>
                          <CartesianGrid vertical={false} />
                          <ChartTooltip
                            cursor={false}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent hideLabel hideIndicator />}
                          />
                          <Bar dataKey="visitors">
                            <LabelList position="top" dataKey="month" fillOpacity={1} />
                            {negativeBarChartData.map((item) => (
                              <Cell
                                key={item.month}
                                fill={item.visitors > 0 ? "var(--chart-1)" : "var(--chart-2)"}
                              />
                            ))}
                          </Bar>
                        </RechartsBarChart>
                      )}

                      {selectedChart.id === 'pie-label' && (
                        <RechartsPieChart>
                          <ChartTooltip
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent nameKey="visitors" hideLabel />}
                          />
                          <Pie data={mixedBarChartData} dataKey="visitors">
                            <LabelList
                              dataKey="browser"
                              className="fill-background"
                              stroke="none"
                              fontSize={12}
                              formatter={(value) =>
                                chartConfig[value as keyof typeof chartConfig]?.label || String(value)
                              }
                            />
                          </Pie>
                        </RechartsPieChart>
                      )}

                      {selectedChart.id === 'pie-donut' && (
                        <RechartsPieChart>
                          <ChartTooltip
                            cursor={false}
                            content={<ChartTooltipContent hideLabel />}
                          />
                          <Pie
                            data={mixedBarChartData}
                            dataKey="visitors"
                            nameKey="browser"
                            innerRadius={60}
                            strokeWidth={5}
                          >
                            <RechartsLabel
                              content={({ viewBox }) => {
                                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                                  const totalVisitors = mixedBarChartData.reduce((acc, curr) => acc + curr.visitors, 0)
                                  return (
                                    <text
                                      x={viewBox.cx}
                                      y={viewBox.cy}
                                      textAnchor="middle"
                                      dominantBaseline="middle"
                                    >
                                      <tspan
                                        x={viewBox.cx}
                                        y={viewBox.cy}
                                        className="fill-foreground text-3xl font-bold"
                                      >
                                        {totalVisitors.toLocaleString()}
                                      </tspan>
                                      <tspan
                                        x={viewBox.cx}
                                        y={(viewBox.cy || 0) + 24}
                                        className="fill-muted-foreground"
                                      >
                                        {t.projects.analyticsBuilder.total}
                                      </tspan>
                                    </text>
                                  )
                                }
                              }}
                            />
                          </Pie>
                        </RechartsPieChart>
                      )}

                      {selectedChart.id === 'radar-lines' && (
                        <RadarChart data={multiSeriesData}>
                          <ChartTooltip
                            cursor={false}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent indicator="line" />}
                          />
                          <PolarAngleAxis dataKey="month" />
                          <PolarGrid radialLines={false} />
                          <Radar
                            dataKey="desktop"
                            fill="var(--color-desktop)"
                            fillOpacity={0}
                            stroke="var(--color-desktop)"
                            strokeWidth={2}
                          />
                          <Radar
                            dataKey="mobile"
                            fill="var(--color-mobile)"
                            fillOpacity={0}
                            stroke="var(--color-mobile)"
                            strokeWidth={2}
                          />
                        </RadarChart>
                      )}

                      {selectedChart.id === 'radial-simple' && (
                        <RadialBarChart data={mixedBarChartData} innerRadius={30} outerRadius={110}>
                          <ChartTooltip
                            cursor={false}
                            wrapperStyle={{ zIndex: 1000, outline: 'none' }}
                            content={<ChartTooltipContent hideLabel nameKey="browser" />}
                          />
                          <RadialBar dataKey="visitors" background />
                        </RadialBarChart>
                      )}

                      {selectedChart.id === 'radial-text' && (
                        <RadialBarChart
                          data={[mixedBarChartData[0]]}
                          startAngle={0}
                          endAngle={250}
                          innerRadius={80}
                          outerRadius={110}
                        >
                          <PolarGrid
                            gridType="circle"
                            radialLines={false}
                            stroke="none"
                            className="first:fill-muted last:fill-background"
                            polarRadius={[86, 74]}
                          />
                          <RadialBar dataKey="visitors" background cornerRadius={10} />
                          <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
                            <RechartsLabel
                              content={({ viewBox }) => {
                                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                                  return (
                                    <text
                                      x={viewBox.cx}
                                      y={viewBox.cy}
                                      textAnchor="middle"
                                      dominantBaseline="middle"
                                    >
                                      <tspan
                                        x={viewBox.cx}
                                        y={viewBox.cy}
                                        className="fill-foreground text-4xl font-bold"
                                      >
                                        {mixedBarChartData[0].visitors.toLocaleString()}
                                      </tspan>
                                      <tspan
                                        x={viewBox.cx}
                                        y={(viewBox.cy || 0) + 24}
                                        className="fill-muted-foreground"
                                      >
                                        {t.projects.analyticsBuilder.total}
                                      </tspan>
                                    </text>
                                  )
                                }
                              }}
                            />
                          </PolarRadiusAxis>
                        </RadialBarChart>
                      )}
                    </ChartContainer>
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
                    onChange={(e) => setChartTitle(e.target.value)}
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
                    onChange={(e) => setChartDescription(e.target.value)}
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
                              setChartTitle(`${entity?.name} - ${metric.name}`);
                              setChartDescription(metric.description);
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
