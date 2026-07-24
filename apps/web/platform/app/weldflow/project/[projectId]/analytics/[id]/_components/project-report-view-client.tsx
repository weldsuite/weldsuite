
import { useState, useEffect, useRef, useTransition, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Link } from '@/lib/router';
import { Plus, TrendingUp, Edit2, GripVertical, MoreVertical, Trash2, Copy, Unlock } from 'lucide-react';
import GridLayout, { Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  type PieLabelRenderProps,
} from 'recharts';
import { analyticsApi } from '@/app/weldflow/lib/api-client';

interface AnalyticsReport {
  id: string;
  title: string;
  description: string | null;
  chartCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface AnalyticsChart {
  id: string;
  reportId: string;
  title: string;
  description: string | null;
  chartType: string;
  entity: string;
  metric: string;
  color: string;
  smoothCurve: boolean;
  fillArea: boolean;
  showDataLabels: boolean;
  showLegend: boolean;
  timeRange: string | null;
  groupBy: string | null;
  aggregation: string | null;
  sortOrder: string | null;
  limit: number | null;
  compareWith: string | null;
  layout: { x: number; y: number; w: number; h: number };
  sortIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ChartDataPoint {
  label: string;
  value: number;
  fill?: string;
  [key: string]: unknown;
}

interface ProjectReportViewClientProps {
  report: AnalyticsReport;
  charts: AnalyticsChart[];
  projectId: string;
}

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export function ProjectReportViewClient({ report, charts: initialCharts, projectId }: ProjectReportViewClientProps) {
  const { t } = useI18n();

  const periodOptions = useMemo(() => [
    { value: 'today', label: t.projects.analyticsBuilder.periods.today },
    { value: 'yesterday', label: t.projects.analyticsBuilder.periods.yesterday },
    { value: 'last_7_days', label: t.projects.analyticsBuilder.periods.last7Days },
    { value: 'last_30_days', label: t.projects.analyticsBuilder.periods.last30Days },
    { value: 'last_90_days', label: t.projects.analyticsBuilder.periods.last90Days },
    { value: 'this_month', label: t.projects.analyticsBuilder.periods.thisMonth },
    { value: 'last_year', label: t.projects.analyticsBuilder.periods.lastYear },
    { value: 'all_time', label: t.projects.analyticsBuilder.periods.allTime },
  ], [t]);

  useBreadcrumbs([
    { label: t.projects.title, href: '/weldflow' },
    { label: t.projects.analytics.title, href: `/weldflow/project/${projectId}/analytics` },
    { label: report.title },
  ]);

  const [isPending, startTransition] = useTransition();
  const reportId = report.id;
  const basePath = `/weldflow/project/${projectId}/analytics`;

  const [charts, setCharts] = useState<AnalyticsChart[]>(initialCharts);
  const [isEditMode, setIsEditMode] = useState(false);
  const [widgetPeriods, setWidgetPeriods] = useState<Record<string, string>>({});
  const [openPopovers, setOpenPopovers] = useState<Record<string, boolean>>({});
  const [chartData, setChartData] = useState<Record<string, ChartDataPoint[]>>({});
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1500);
  const [selectedArrangement, setSelectedArrangement] = useState<'custom' | 1 | 2 | 3 | 4>('custom');
  const [pageTitle, setPageTitle] = useState(report.title);
  const [pageDescription, setPageDescription] = useState(report.description || '');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);

  const STANDARD_CHART_HEIGHT = 8;

  // Initialize layouts from charts
  useEffect(() => {
    if (charts.length > 0) {
      const chartLayouts = charts.map((chart) => ({
        i: chart.id,
        x: chart.layout?.x ?? 0,
        y: chart.layout?.y ?? 0,
        w: chart.layout?.w ?? 6,
        h: chart.layout?.h ?? STANDARD_CHART_HEIGHT,
        minW: 4,
        minH: 4,
      }));
      setLayouts(chartLayouts);
    }
  }, [charts]);

  // Track container width for responsive grid
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };

    const timer = setTimeout(updateWidth, 50);
    window.addEventListener('resize', updateWidth);

    const resizeObserver = new ResizeObserver(() => {
      updateWidth();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWidth);
      resizeObserver.disconnect();
    };
  }, [charts]);

  // Fetch real chart data
  useEffect(() => {
    async function loadData() {
      if (charts.length === 0) {
        setIsLoadingData(false);
        return;
      }

      try {
        const result = await analyticsApi.getChartsData(
          report.id,
          charts.map((chart) => ({
            chartId: chart.id,
            entity: chart.entity,
            metric: chart.metric,
            timeRange: widgetPeriods[chart.id] || chart.timeRange || 'last_30_days',
            groupBy: chart.groupBy || 'day',
            aggregation: chart.aggregation || 'sum',
            sortOrder: chart.sortOrder || 'asc',
            limit: chart.limit || undefined,
            projectId,
          })),
        );

        if (result.success && result.data) {
          setChartData(result.data as Record<string, ChartDataPoint[]>);
        }
      } catch (error) {
        console.error('Failed to load chart data:', error);
      } finally {
        setIsLoadingData(false);
      }
    }

    loadData();
  }, [charts, widgetPeriods, projectId, report.id]);

  // Handle layout changes
  const handleLayoutChange = (newLayout: Layout[]) => {
    if (!isEditMode) return;
    setLayouts(newLayout);
    setSelectedArrangement(detectArrangement(newLayout));
    setHasUnsavedChanges(true);
  };

  // Save layout changes
  const saveLayoutChanges = async () => {
    startTransition(async () => {
      await analyticsApi.updateReport(reportId, {
        title: pageTitle,
        description: pageDescription,
      });

      const layoutUpdates = layouts.map((layout) => ({
        chartId: layout.i,
        layout: {
          x: layout.x,
          y: layout.y,
          w: layout.w,
          h: layout.h,
          minW: layout.minW,
          minH: layout.minH,
        },
      }));

      await analyticsApi.updateChartLayouts(reportId, layoutUpdates);

      setHasUnsavedChanges(false);
      setIsEditMode(false);
    });
  };

  // Cancel layout changes
  const cancelLayoutChanges = () => {
    const originalLayouts = charts.map((chart) => ({
      i: chart.id,
      x: chart.layout?.x ?? 0,
      y: chart.layout?.y ?? 0,
      w: chart.layout?.w ?? 6,
      h: chart.layout?.h ?? STANDARD_CHART_HEIGHT,
      minW: 4,
      minH: 4,
    }));
    setLayouts(originalLayouts);
    setPageTitle(report.title);
    setPageDescription(report.description || '');
    setHasUnsavedChanges(false);
    setIsEditMode(false);
  };

  // Arrange charts in a grid with specified number per row
  const arrangeCharts = (chartsPerRow: 1 | 2 | 3 | 4) => {
    const colWidth = Math.floor(12 / chartsPerRow);
    const heightMap: Record<number, number> = { 1: 12, 2: 10, 3: 7, 4: 6 };
    const chartHeight = heightMap[chartsPerRow] || STANDARD_CHART_HEIGHT;

    const arrangedLayouts = charts.map((chart, index) => ({
      i: chart.id,
      x: (index % chartsPerRow) * colWidth,
      y: Math.floor(index / chartsPerRow) * chartHeight,
      w: colWidth,
      h: chartHeight,
      minW: 3,
      minH: 4,
    }));
    setLayouts(arrangedLayouts);
    setSelectedArrangement(chartsPerRow);
    setHasUnsavedChanges(true);
  };

  // Check if current layout matches a preset arrangement
  const detectArrangement = (currentLayouts: Layout[]): 'custom' | 1 | 2 | 3 | 4 => {
    if (currentLayouts.length === 0) return 'custom';

    for (const chartsPerRow of [1, 2, 3, 4] as const) {
      const colWidth = Math.floor(12 / chartsPerRow);
      const heightMap: Record<number, number> = { 1: 12, 2: 10, 3: 7, 4: 6 };
      const expectedHeight = heightMap[chartsPerRow];

      const matchesPreset = currentLayouts.every((layout, index) => {
        const expectedX = (index % chartsPerRow) * colWidth;
        const expectedY = Math.floor(index / chartsPerRow) * expectedHeight;
        return layout.w === colWidth && layout.h === expectedHeight && layout.x === expectedX && layout.y === expectedY;
      });

      if (matchesPreset) return chartsPerRow;
    }

    return 'custom';
  };

  // Remove a widget
  const removeWidget = async (chartId: string) => {
    startTransition(async () => {
      const result = await analyticsApi.deleteChart(reportId, chartId);
      if (result.success) {
        setCharts((prev) => prev.filter((w) => w.id !== chartId));
        setLayouts((prev) => prev.filter((l) => l.i !== chartId));
      }
    });
  };

  // Duplicate a widget
  const handleDuplicateChart = async (chartId: string) => {
    startTransition(async () => {
      const result = await analyticsApi.duplicateChart(reportId, chartId);
      if (result.success && result.data) {
        setCharts((prev) => [...prev, result.data!]);
        const newLayout = {
          i: result.data.id,
          x: result.data.layout?.x ?? 0,
          y: result.data.layout?.y ?? 0,
          w: result.data.layout?.w ?? 6,
          h: result.data.layout?.h ?? STANDARD_CHART_HEIGHT,
          minW: 4,
          minH: 4,
        };
        setLayouts((prev) => [...prev, newLayout]);
      }
    });
  };

  const renderChart = (chart: AnalyticsChart, data: ChartDataPoint[]) => {
    if (!data || data.length === 0) {
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground">{t.projects.analyticsReports.noDataAvailable}</div>
      );
    }

    const chartType = chart.chartType;

    if (chartType.startsWith('area')) {
      return (
        <ResponsiveContainer width="100%" height="100%">
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
        <ResponsiveContainer width="100%" height="100%">
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
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={chart.showDataLabels}
              label={chart.showDataLabels ? ((props: PieLabelRenderProps) => `${props.name ?? ''} ${((props.percent ?? 0) * 100).toFixed(0)}%`) : undefined}
              outerRadius={80}
              innerRadius={chartType.includes('donut') ? 50 : 0}
              fill="#8884d8"
              dataKey="value"
              nameKey="label"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.fill || CHART_COLORS[index % CHART_COLORS.length]} />
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
      <ResponsiveContainer width="100%" height="100%">
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

  // Empty state - no charts
  if (charts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">{pageTitle}</h1>
            {pageDescription && <p className="text-muted-foreground">{pageDescription}</p>}
          </div>
          <Button asChild>
            <Link href={`${basePath}/builder?reportId=${report.id}&addChart=true`}>
              <Plus className="mr-0.5 h-4 w-4" />
              {t.projects.analyticsReports.addChart}
            </Link>
          </Button>
        </div>

        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-muted mb-4">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-muted-foreground text-sm">{t.projects.analyticsReports.noCharts}</p>
            <Button className="mt-6" asChild>
              <Link href={`${basePath}/builder?reportId=${report.id}&addChart=true`}>
                <Plus className="mr-0.5 h-4 w-4" />
                {t.projects.analyticsReports.addChart}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Grid layout styles */}
      <style>{`
        .react-grid-item > .react-resizable-handle {
          display: ${isEditMode ? 'block' : 'none'};
        }
        .react-grid-item.react-grid-placeholder {
          background: hsl(var(--primary) / 0.1);
          border: 2px dashed hsl(var(--primary) / 0.3);
          border-radius: 8px;
        }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            {isEditMode && isEditingTitle ? (
              <div className="relative inline-block">
                <span className="text-2xl font-bold tracking-tight invisible whitespace-pre">{pageTitle || 'Title'}</span>
                <input
                  type="text"
                  value={pageTitle}
                  onChange={(e) => {
                    setPageTitle(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  onBlur={() => setIsEditingTitle(false)}
                  onKeyDown={(e) => e.key === 'Enter' && setIsEditingTitle(false)}
                  autoFocus
                  className="absolute inset-0 text-2xl font-bold tracking-tight bg-transparent border-b border-primary focus:outline-none"
                  placeholder={t.projects.analyticsReports.titlePlaceholderEdit}
                />
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-bold tracking-tight">{pageTitle}</h1>
                {isEditMode && (
                  <Button
                    variant="ghost"
                    onClick={() => setIsEditingTitle(true)}
                    className="p-1 hover:bg-muted rounded transition-colors"
                  >
                    <Edit2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            {isEditMode && isEditingDescription ? (
              <div className="relative inline-block">
                <span className="text-muted-foreground invisible whitespace-pre">{pageDescription || 'Description'}</span>
                <input
                  type="text"
                  value={pageDescription}
                  onChange={(e) => {
                    setPageDescription(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  onBlur={() => setIsEditingDescription(false)}
                  onKeyDown={(e) => e.key === 'Enter' && setIsEditingDescription(false)}
                  autoFocus
                  className="absolute inset-0 text-muted-foreground bg-transparent border-b border-primary focus:outline-none"
                  placeholder={t.projects.analyticsReports.descriptionPlaceholderEdit}
                />
              </div>
            ) : (
              <>
                {pageDescription && <p className="text-muted-foreground">{pageDescription}</p>}
                {isEditMode && (
                  <Button
                    variant="ghost"
                    onClick={() => setIsEditingDescription(true)}
                    className="p-1 hover:bg-muted rounded transition-colors"
                  >
                    <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {isEditMode ? (
            <>
              <Button variant="outline" size="sm" onClick={cancelLayoutChanges} disabled={isPending}>
                {t.projects.analyticsReports.cancel}
              </Button>
              <Button size="sm" onClick={saveLayoutChanges} disabled={!hasUnsavedChanges || isPending}>
                {isPending ? t.projects.analyticsReports.savingLayout : t.projects.analyticsReports.saveLayout}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setIsEditMode(true)}>
                {t.projects.analyticsReports.edit}
              </Button>
              <Button size="sm" asChild>
                <Link href={`${basePath}/builder?reportId=${report.id}&addChart=true`}>
                  {t.projects.analyticsReports.addChart}
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Edit mode indicator */}
      {isEditMode && (
        <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Unlock className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
              {t.projects.analyticsReports.editModeActive}
            </span>
          </div>
          <div className="flex border rounded-md overflow-hidden bg-white dark:bg-background">
            <Button
              variant="ghost"
              className={cn(
                "px-3 py-1.5 text-sm font-medium border-r transition-colors",
                selectedArrangement === 'custom'
                  ? "bg-primary text-primary-foreground"
                  : "text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary"
              )}
            >
              {t.projects.analyticsReports.custom}
            </Button>
            {[1, 2, 3, 4].map((num) => (
              <Button
                variant="ghost"
                key={num}
                onClick={() => arrangeCharts(num as 1 | 2 | 3 | 4)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium transition-colors",
                  num < 4 && "border-r",
                  selectedArrangement === num
                    ? "bg-primary text-primary-foreground"
                    : "text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary"
                )}
              >
                {num}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Charts Grid */}
      <div ref={containerRef} className="w-full">
        <GridLayout
          className="layout"
          layout={layouts}
          cols={12}
          rowHeight={54}
          width={containerWidth}
          onLayoutChange={handleLayoutChange}
          draggableHandle=".drag-handle"
          onDragStart={() => setIsDragging(true)}
          onDragStop={() => setIsDragging(false)}
          isDraggable={isEditMode}
          isResizable={isEditMode}
          resizeHandles={['se', 'sw', 'ne', 'nw']}
          margin={[16, 16]}
          containerPadding={[0, 0]}
        >
          {charts.map((chart) => (
            <div key={chart.id} className="h-full w-full">
              <Card className={`relative w-full h-full flex flex-col border-gray-200/50 dark:border-border/50 shadow-none ${isDragging ? 'opacity-80' : ''}`}>
                {/* Edit mode controls */}
                {isEditMode && (
                  <div className="absolute top-4 right-4 z-10 flex items-center gap-1">
                    <Button variant="ghost" className="drag-handle p-1 rounded hover:bg-gray-100 dark:hover:bg-secondary cursor-move">
                      <GripVertical className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="p-1 rounded hover:bg-gray-100 dark:hover:bg-secondary">
                          <MoreVertical className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem
                          onClick={() => handleDuplicateChart(chart.id)}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t.projects.analyticsReports.duplicateChart}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => removeWidget(chart.id)}
                          className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/50"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                          {t.projects.analyticsReports.deleteChart}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}

                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">{chart.title}</CardTitle>
                      {chart.description && <CardDescription className="text-sm">{chart.description}</CardDescription>}
                    </div>
                    {!isEditMode && (
                      <Popover
                        open={openPopovers[chart.id] || false}
                        onOpenChange={(open) => setOpenPopovers((prev) => ({ ...prev, [chart.id]: open }))}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            aria-expanded={openPopovers[chart.id] || false}
                            className="w-[140px] h-9 justify-between"
                          >
                            {periodOptions.find((option) => option.value === (widgetPeriods[chart.id] || chart.timeRange || 'last_30_days'))?.label}
                            <ChevronDown className="opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[140px] p-0">
                          <Command>
                            <CommandList>
                              <CommandEmpty>{t.projects.analyticsReports.noPeriodFound}</CommandEmpty>
                              <CommandGroup>
                                {periodOptions.map((option) => (
                                  <CommandItem
                                    key={option.value}
                                    value={option.value}
                                    onSelect={(currentValue) => {
                                      setWidgetPeriods((prev) => ({ ...prev, [chart.id]: currentValue }));
                                      setOpenPopovers((prev) => ({ ...prev, [chart.id]: false }));
                                    }}
                                  >
                                    {option.label}
                                    <Check
                                      className={cn(
                                        "ml-auto",
                                        (widgetPeriods[chart.id] || chart.timeRange || 'last_30_days') === option.value ? "opacity-100" : "opacity-0"
                                      )}
                                    />
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pb-2 pt-0 flex-1 min-h-0 overflow-hidden">
                  {isLoadingData && !chartData[chart.id] ? (
                    <PageLoader fullScreen={false} />
                  ) : (
                    renderChart(chart, chartData[chart.id] || [])
                  )}
                </CardContent>
              </Card>
            </div>
          ))}
        </GridLayout>
      </div>
    </div>
  );
}
