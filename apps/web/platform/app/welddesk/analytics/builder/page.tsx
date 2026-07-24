
import React, { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateAnalyticsChart } from '@/hooks/queries/use-helpdesk-queries';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  ChevronDown, BarChart3, PieChart, Activity, TrendingUp,
  AreaChart as AreaChartIcon, Layers, Ticket, Users, MessageSquare,
  Clock, Star, Headphones, BarChart2,
  Plus, Divide, ArrowUp, ArrowDown, TrendingUpDown, SortAsc, SortDesc
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

// chart type icons mapped by id — defined at module scope so icon references are stable
const chartTypeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  'area-chart': AreaChartIcon,
  'area-linear': AreaChartIcon,
  'area-stacked': Layers,
  'bar-multiple': BarChart3,
  'bar-mixed': BarChart2,
  'bar-stacked': Layers,
  'bar-negative': TrendingUpDown,
  'pie-label': PieChart,
  'pie-donut': Activity,
  'radar-lines': Activity,
  'radial-simple': Activity,
  'radial-text': Activity,
};

// entity icons mapped by id — defined at module scope
const entityIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  tickets: Ticket,
  conversations: MessageSquare,
  customers: Users,
  agents: Headphones,
  response_time: Clock,
  satisfaction: Star,
};

export default function HelpdeskAnalyticsBuilderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reportId = searchParams.get('reportId');
  const [isPending] = useTransition();
  const createChartMutation = useCreateAnalyticsChart();
  const { t } = useI18n();
  const ta = t.helpdesk.analyticsReports;

  const chartTypes = [
    { id: 'area-chart', name: ta.chartTypeAreaChart, icon: chartTypeIcons['area-chart'], description: ta.chartTypeAreaChartDesc },
    { id: 'area-linear', name: ta.chartTypeAreaLinear, icon: chartTypeIcons['area-linear'], description: ta.chartTypeAreaLinearDesc },
    { id: 'area-stacked', name: ta.chartTypeAreaStacked, icon: chartTypeIcons['area-stacked'], description: ta.chartTypeAreaStackedDesc },
    { id: 'bar-multiple', name: ta.chartTypeBarMultiple, icon: chartTypeIcons['bar-multiple'], description: ta.chartTypeBarMultipleDesc },
    { id: 'bar-mixed', name: ta.chartTypeBarMixed, icon: chartTypeIcons['bar-mixed'], description: ta.chartTypeBarMixedDesc },
    { id: 'bar-stacked', name: ta.chartTypeBarStacked, icon: chartTypeIcons['bar-stacked'], description: ta.chartTypeBarStackedDesc },
    { id: 'bar-negative', name: ta.chartTypeBarNegative, icon: chartTypeIcons['bar-negative'], description: ta.chartTypeBarNegativeDesc },
    { id: 'pie-label', name: ta.chartTypePieLabel, icon: chartTypeIcons['pie-label'], description: ta.chartTypePieLabelDesc },
    { id: 'pie-donut', name: ta.chartTypePieDonut, icon: chartTypeIcons['pie-donut'], description: ta.chartTypePieDonutDesc },
    { id: 'radar-lines', name: ta.chartTypeRadarLines, icon: chartTypeIcons['radar-lines'], description: ta.chartTypeRadarLinesDesc },
    { id: 'radial-simple', name: ta.chartTypeRadialSimple, icon: chartTypeIcons['radial-simple'], description: ta.chartTypeRadialSimpleDesc },
    { id: 'radial-text', name: ta.chartTypeRadialText, icon: chartTypeIcons['radial-text'], description: ta.chartTypeRadialTextDesc },
  ];

  const entities = [
    { id: 'tickets', name: ta.entityTickets, icon: entityIcons.tickets },
    { id: 'conversations', name: ta.entityConversations, icon: entityIcons.conversations },
    { id: 'customers', name: ta.entityCustomers, icon: entityIcons.customers },
    { id: 'agents', name: ta.entityAgents, icon: entityIcons.agents },
    { id: 'response_time', name: ta.entityResponseTime, icon: entityIcons.response_time },
    { id: 'satisfaction', name: ta.entitySatisfaction, icon: entityIcons.satisfaction },
  ];

  const metrics: Record<string, Array<{ id: string; name: string; description: string }>> = {
    tickets: [
      { id: 'total_tickets', name: ta.metricTotalTickets, description: ta.metricTotalTicketsDesc },
      { id: 'open_tickets', name: ta.metricOpenTickets, description: ta.metricOpenTicketsDesc },
      { id: 'closed_tickets', name: ta.metricClosedTickets, description: ta.metricClosedTicketsDesc },
      { id: 'tickets_by_status', name: ta.metricTicketsByStatus, description: ta.metricTicketsByStatusDesc },
      { id: 'tickets_by_priority', name: ta.metricTicketsByPriority, description: ta.metricTicketsByPriorityDesc },
      { id: 'tickets_by_day', name: ta.metricTicketsByDay, description: ta.metricTicketsByDayDesc },
      { id: 'escalated_tickets', name: ta.metricEscalatedTickets, description: ta.metricEscalatedTicketsDesc },
    ],
    conversations: [
      { id: 'total_conversations', name: ta.metricTotalConversations, description: ta.metricTotalConversationsDesc },
      { id: 'active_conversations', name: ta.metricActiveConversations, description: ta.metricActiveConversationsDesc },
      { id: 'conversations_by_channel', name: ta.metricConversationsByChannel, description: ta.metricConversationsByChannelDesc },
      { id: 'avg_messages', name: ta.metricAvgMessages, description: ta.metricAvgMessagesDesc },
      { id: 'conversations_by_day', name: ta.metricConversationsByDay, description: ta.metricConversationsByDayDesc },
    ],
    customers: [
      { id: 'total_customers', name: ta.metricTotalCustomers, description: ta.metricTotalCustomersDesc },
      { id: 'new_customers', name: ta.metricNewCustomers, description: ta.metricNewCustomersDesc },
      { id: 'returning_customers', name: ta.metricReturningCustomers, description: ta.metricReturningCustomersDesc },
      { id: 'customers_by_tickets', name: ta.metricCustomersByTickets, description: ta.metricCustomersByTicketsDesc },
      { id: 'top_customers', name: ta.metricTopCustomers, description: ta.metricTopCustomersDesc },
    ],
    agents: [
      { id: 'total_agents', name: ta.metricTotalAgents, description: ta.metricTotalAgentsDesc },
      { id: 'active_agents', name: ta.metricActiveAgents, description: ta.metricActiveAgentsDesc },
      { id: 'tickets_per_agent', name: ta.metricTicketsPerAgent, description: ta.metricTicketsPerAgentDesc },
      { id: 'agent_performance', name: ta.metricAgentPerformance, description: ta.metricAgentPerformanceDesc },
      { id: 'agent_response_time', name: ta.metricAgentResponseTime, description: ta.metricAgentResponseTimeDesc },
    ],
    response_time: [
      { id: 'avg_first_response', name: ta.metricAvgFirstResponse, description: ta.metricAvgFirstResponseDesc },
      { id: 'avg_resolution_time', name: ta.metricAvgResolutionTime, description: ta.metricAvgResolutionTimeDesc },
      { id: 'response_time_trend', name: ta.metricResponseTimeTrend, description: ta.metricResponseTimeTrendDesc },
      { id: 'sla_compliance', name: ta.metricSlaCompliance, description: ta.metricSlaComplianceDesc },
      { id: 'response_by_priority', name: ta.metricResponseByPriority, description: ta.metricResponseByPriorityDesc },
    ],
    satisfaction: [
      { id: 'csat_score', name: ta.metricCsatScore, description: ta.metricCsatScoreDesc },
      { id: 'nps_score', name: ta.metricNpsScore, description: ta.metricNpsScoreDesc },
      { id: 'satisfaction_trend', name: ta.metricSatisfactionTrend, description: ta.metricSatisfactionTrendDesc },
      { id: 'ratings_distribution', name: ta.metricRatingsDistribution, description: ta.metricRatingsDistributionDesc },
      { id: 'satisfaction_by_agent', name: ta.metricSatisfactionByAgent, description: ta.metricSatisfactionByAgentDesc },
    ],
  };

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
  const [compareWith] = useState('');
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
      router.push('/welddesk/analytics');
      return;
    }

    createChartMutation.mutate(
      {
        reportId: reportId!,
        title: chartTitle || ta.untitledChart,
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
      {
        onSuccess: (result) => {
          if (result.success) {
            router.push(`/welddesk/analytics/${reportId}`);
          }
        },
      }
    );
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
              {t.helpdesk.analyticsReports.preview}
            </Button>
          </div>

          <div className="flex-1 flex items-center justify-center p-8 overflow-visible">
            <div className="w-full max-w-3xl relative z-20 overflow-visible">
                <Card className="border-gray-200/50 dark:border-border/50 shadow-none overflow-visible">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg">{chartTitle || t.helpdesk.analyticsReports.chartTitle}</CardTitle>
                    <CardDescription className="text-sm">
                      {chartDescription || t.helpdesk.analyticsReports.chartDescription}
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
                          <Bar dataKey="visitors" layout="vertical" radius={5} />
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
                          <ChartLegend content={<ChartLegendContent />} />
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
                              formatter={(value: keyof typeof chartConfig) =>
                                chartConfig[value]?.label || value
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
                                        Total
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
                                        Total
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
            <h2 className="text-sm font-semibold text-gray-900 dark:text-foreground">{t.helpdesk.analyticsReports.chartConfiguration}</h2>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => router.push('/welddesk/analytics')}
                variant="outline"
                size="sm"
              >
                {t.helpdesk.analyticsReports.close}
              </Button>
              <Button
                onClick={handleSave}
                size="sm"
                disabled={!selectedEntity || !selectedMetric || !chartTitle || !reportId || isPending}
              >
                {isPending ? t.helpdesk.analyticsReports.addingChart : t.helpdesk.analyticsReports.addChart}
              </Button>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-6">
            {/* Basic Information */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.helpdesk.analyticsReports.basicInformation}</h3>

              <div className="space-y-5">
                <div>
                  <Label htmlFor="title" className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">
                    {t.helpdesk.analyticsReports.reportTitle}
                  </Label>
                  <Input
                    id="title"
                    value={chartTitle}
                    onChange={(e) => setChartTitle(e.target.value)}
                    placeholder={ta.chartTitlePlaceholder}
                    className="h-9 text-sm bg-white dark:bg-background border-gray-200 dark:border-border focus:border-gray-300 dark:focus:border-gray-700 transition-colors shadow-none"
                  />
                </div>

                <div>
                  <Label htmlFor="description" className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">
                    {t.helpdesk.analyticsReports.reportDescription}
                  </Label>
                  <Textarea
                    id="description"
                    value={chartDescription}
                    onChange={(e) => setChartDescription(e.target.value)}
                    placeholder={ta.briefDescription}
                    className="min-h-[60px] text-sm resize-none bg-white dark:bg-background border-gray-200 dark:border-border focus:border-gray-300 dark:focus:border-gray-700 transition-colors shadow-none"
                  />
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-gray-200 dark:bg-secondary"></div>

            {/* Data Source */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.helpdesk.analyticsReports.dataSource}</h3>

              <div className="space-y-5">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.entity}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span className="flex items-center gap-2">
                          {selectedEntity ? (
                            <>
                              {React.createElement(entities.find(e => e.id === selectedEntity)?.icon || Ticket, { className: "h-3.5 w-3.5 text-gray-500" })}
                              <span>{entities.find(e => e.id === selectedEntity)?.name}</span>
                            </>
                          ) : (
                            <span className="text-gray-500">{t.helpdesk.analyticsReports.chooseEntity}</span>
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
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.metric}</Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                          <span>
                            {selectedMetric ?
                              metrics[selectedEntity]?.find(m => m.id === selectedMetric)?.name
                              : ta.chooseMetric
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
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.helpdesk.analyticsReports.timeAndGrouping}</h3>

              <div className="space-y-5">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.period}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span>
                          {[
                            { id: 'today', label: ta.today },
                            { id: 'yesterday', label: ta.yesterday },
                            { id: 'last_7_days', label: ta.last7Days },
                            { id: 'last_30_days', label: ta.last30Days },
                            { id: 'last_90_days', label: ta.last90Days },
                            { id: 'last_year', label: ta.lastYear },
                            { id: 'this_month', label: ta.thisMonth },
                            { id: 'all_time', label: ta.allTime },
                          ].find(r => r.id === timeRange)?.label || ta.selectPeriod}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'today', label: ta.today },
                        { id: 'yesterday', label: ta.yesterday },
                        { id: 'last_7_days', label: ta.last7Days },
                        { id: 'last_30_days', label: ta.last30Days },
                        { id: 'last_90_days', label: ta.last90Days },
                        { id: 'last_year', label: ta.lastYear },
                        { id: 'this_month', label: ta.thisMonth },
                        { id: 'all_time', label: ta.allTime },
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
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.groupBy}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span>
                          {[
                            { id: 'hour', label: ta.hour },
                            { id: 'day', label: ta.day },
                            { id: 'week', label: ta.week },
                            { id: 'month', label: ta.month },
                            { id: 'quarter', label: ta.quarter },
                            { id: 'year', label: ta.year },
                          ].find(g => g.id === groupBy)?.label || ta.selectGrouping}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'hour', label: ta.hour },
                        { id: 'day', label: ta.day },
                        { id: 'week', label: ta.week },
                        { id: 'month', label: ta.month },
                        { id: 'quarter', label: ta.quarter },
                        { id: 'year', label: ta.year },
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
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.calculation}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span className="flex items-center gap-2">
                          {(() => {
                            const agg = [
                              { id: 'sum', label: ta.totalSum, icon: Plus },
                              { id: 'average', label: ta.average, icon: Divide },
                              { id: 'count', label: ta.count, icon: TrendingUp },
                              { id: 'max', label: ta.maximum, icon: ArrowUp },
                              { id: 'min', label: ta.minimum, icon: ArrowDown },
                            ].find(a => a.id === aggregation);
                            return (
                              <>
                                {agg?.icon && React.createElement(agg.icon, { className: "h-3.5 w-3.5 text-gray-500" })}
                                <span>{agg?.label || ta.selectCalculation}</span>
                              </>
                            );
                          })()}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'sum', label: ta.totalSum, icon: Plus },
                        { id: 'average', label: ta.average, icon: Divide },
                        { id: 'count', label: ta.count, icon: TrendingUp },
                        { id: 'max', label: ta.maximum, icon: ArrowUp },
                        { id: 'min', label: ta.minimum, icon: ArrowDown },
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
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.helpdesk.analyticsReports.appearance}</h3>

              <div className="space-y-3">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.color}</Label>
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
                                { value: '#3b82f6', name: ta.colorBlue },
                                { value: '#10b981', name: ta.colorGreen },
                                { value: '#8b5cf6', name: ta.colorPurple },
                                { value: '#f59e0b', name: ta.colorAmber },
                                { value: '#ec4899', name: ta.colorPink },
                                { value: '#ef4444', name: ta.colorRed },
                                { value: '#06b6d4', name: ta.colorCyan },
                                { value: '#84cc16', name: ta.colorLime },
                              ];
                              return colors.find(c => c.value === chartColor)?.name || ta.colorCustom;
                            })()}
                          </span>
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { value: '#3b82f6', name: ta.colorBlue },
                        { value: '#10b981', name: ta.colorGreen },
                        { value: '#8b5cf6', name: ta.colorPurple },
                        { value: '#f59e0b', name: ta.colorAmber },
                        { value: '#ec4899', name: ta.colorPink },
                        { value: '#ef4444', name: ta.colorRed },
                        { value: '#06b6d4', name: ta.colorCyan },
                        { value: '#84cc16', name: ta.colorLime },
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
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.helpdesk.analyticsReports.smoothLines}</Label>
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
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.helpdesk.analyticsReports.fillArea}</Label>
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
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.helpdesk.analyticsReports.showDataPoints}</Label>
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
                    <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground">{t.helpdesk.analyticsReports.showLegend}</Label>
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
              <h3 className="text-xs font-semibold text-gray-500 dark:text-muted-foreground uppercase tracking-wider">{t.helpdesk.analyticsReports.dataOptions}</h3>

              <div className="space-y-5">
                <div>
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.sortOrder}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span className="flex items-center gap-2">
                          {(() => {
                            const sort = [
                              { id: 'asc', label: ta.ascending, icon: SortAsc },
                              { id: 'desc', label: ta.descending, icon: SortDesc },
                            ].find(s => s.id === sortOrder);
                            return (
                              <>
                                {sort?.icon && React.createElement(sort.icon, { className: "h-3.5 w-3.5 text-gray-500" })}
                                <span>{sort?.label || ta.selectOrder}</span>
                              </>
                            );
                          })()}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}>
                      {[
                        { id: 'asc', label: ta.ascending, icon: SortAsc },
                        { id: 'desc', label: ta.descending, icon: SortDesc },
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
                  <Label className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-1.5 block">{t.helpdesk.analyticsReports.maximumItems}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-between text-sm bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-200 focus-visible:border-gray-200 data-[state=open]:border-gray-300">
                        <span>{limit === 'All' ? ta.showAll : ta.items.replace('{count}', limit)}</span>
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
                          {num === 'All' ? ta.showAll : ta.items.replace('{count}', num)}
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
