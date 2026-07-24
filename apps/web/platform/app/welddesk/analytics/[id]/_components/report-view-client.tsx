
import { useState, useEffect, useRef, useTransition } from 'react';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { Plus, Edit2, GripVertical, MoreVertical, Trash2, Copy, Unlock } from 'lucide-react';
import GridLayout, { Layout } from 'react-grid-layout';
const GridLayoutFixed = GridLayout;
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@weldsuite/ui/components/command';
import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
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
  YAxis,
} from 'recharts';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@weldsuite/ui/components/chart';
import {
  type AnalyticsReport,
  type AnalyticsChart,
} from '@/hooks/queries/use-helpdesk-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { ChartLayout } from '@/lib/db/schema/helpdesk-analytics-charts';
import type { ChartDataPoint } from '../../lib/analytics-data';
import { EmptyStateIllustration } from '@/components/entity-list';

interface ReportViewClientProps {
  report: AnalyticsReport;
  initialCharts: AnalyticsChart[];
  allReports: AnalyticsReport[];
}

export function ReportViewClient({ report, initialCharts, allReports }: ReportViewClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { getClient } = useAppApiClient();
  const { t } = useI18n();

  const periodOptions = [
    { value: 'today', label: t.helpdesk.analyticsReports.today },
    { value: 'yesterday', label: t.helpdesk.analyticsReports.yesterday },
    { value: 'last_7_days', label: t.helpdesk.analyticsReports.last7Days },
    { value: 'last_30_days', label: t.helpdesk.analyticsReports.last30Days },
    { value: 'last_90_days', label: t.helpdesk.analyticsReports.last90Days },
    { value: 'this_month', label: t.helpdesk.analyticsReports.yearToDate },
    { value: 'last_year', label: t.helpdesk.analyticsReports.last12Months },
    { value: 'all_time', label: t.helpdesk.analyticsReports.allTime },
  ];
  const reportId = report.id;

  const [charts, setCharts] = useState<AnalyticsChart[]>(initialCharts);
  useEffect(() => {
    setCharts(initialCharts);
  }, [initialCharts]);
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
  const [reports, setReports] = useState<AnalyticsReport[]>(allReports);
  const [reportSelectorOpen, setReportSelectorOpen] = useState(false);
  const [createReportDialogOpen, setCreateReportDialogOpen] = useState(false);
  const [newReportTitle, setNewReportTitle] = useState('');
  const [newReportDescription, setNewReportDescription] = useState('');

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
        minW: chart.layout?.minW ?? 4,
        minH: chart.layout?.minH ?? 4,
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
    const fetchChartData = async () => {
      if (charts.length === 0) {
        setIsLoadingData(false);
        return;
      }

      setIsLoadingData(true);
      try {
        const chartsConfig = charts.map((chart) => ({
          chartId: chart.id,
          entity: chart.entity,
          metric: chart.metric,
          timeRange: widgetPeriods[chart.id] || chart.timeRange || 'last_30_days',
          groupBy: chart.groupBy || 'day',
          aggregation: chart.aggregation || 'count',
          sortOrder: chart.sortOrder || 'asc',
          limit: chart.limit || undefined,
        }));

        const client = await getClient();
        const result = await client.post<{ data: Record<string, ChartDataPoint[]> }>('/helpdesk-analytics/charts/batch-data', { charts: chartsConfig });
        setChartData(result.data);
      } catch (error) {
        console.error('Failed to fetch chart data:', error);
      } finally {
        setIsLoadingData(false);
      }
    };

    fetchChartData();
  }, [charts, widgetPeriods, getClient]);

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
      // Update report title/description
      const client = await getClient();
      // Report update is PATCH /helpdesk-analytics/:id on app-api (the legacy
      // PUT /analytics/reports/:id shape does not exist there).
      await client.patch(`/helpdesk-analytics/${reportId}`, {
        title: pageTitle,
        description: pageDescription,
      });

      // Update chart layouts
      const layoutUpdates = layouts.map((layout) => ({
        chartId: layout.i,
        layout: {
          x: layout.x,
          y: layout.y,
          w: layout.w,
          h: layout.h,
          minW: layout.minW,
          minH: layout.minH,
        } as ChartLayout,
      }));

      await client.patch(`/helpdesk-analytics/reports/${reportId}/layouts`, { layouts: layoutUpdates });

      setHasUnsavedChanges(false);
      setIsEditMode(false);
    });
  };

  // Cancel layout changes
  const cancelLayoutChanges = () => {
    // Reset layouts from charts
    const originalLayouts = charts.map((chart) => ({
      i: chart.id,
      x: chart.layout?.x ?? 0,
      y: chart.layout?.y ?? 0,
      w: chart.layout?.w ?? 6,
      h: chart.layout?.h ?? STANDARD_CHART_HEIGHT,
      minW: chart.layout?.minW ?? 4,
      minH: chart.layout?.minH ?? 4,
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
    const heightMap: Record<number, number> = {
      1: 12,
      2: 10,
      3: 7,
      4: 6,
    };
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
        return layout.w === colWidth &&
               layout.h === expectedHeight &&
               layout.x === expectedX &&
               layout.y === expectedY;
      });

      if (matchesPreset) return chartsPerRow;
    }

    return 'custom';
  };

  // Remove a widget
  const removeWidget = async (chartId: string) => {
    startTransition(async () => {
      const client = await getClient();
      // Non-2xx throws on the app-api client, so reaching the next line means
      // the delete succeeded (there is no {success} flag to gate on).
      await client.delete<{ data: { id: string } }>(`/helpdesk-analytics/charts/${chartId}`);
      setCharts((prev) => prev.filter((w) => w.id !== chartId));
      setLayouts((prev) => prev.filter((l) => l.i !== chartId));
    });
  };

  // Duplicate a widget.
  //
  // Was POST `/helpdesk/analytics/charts/:chartId/duplicate` on api-worker, which
  // does not exist there either (only `/analytics/reports/:id/duplicate` does), so
  // duplication has always 404'd. Neither worker has a chart-duplicate verb.
  //
  // It doesn't need one: the source chart is already in local state, so a
  // duplicate is just a create. Re-POST its config through app-api's existing
  // `POST /helpdesk-analytics/charts`, which assigns the new id and sortIndex.
  // That endpoint answers `{ data: { id } }` rather than the full row, so the
  // local copy is built from the source chart plus the returned id.
  const handleDuplicateChart = async (chartId: string) => {
    const source = charts.find((c) => c.id === chartId);
    if (!source) return;

    startTransition(async () => {
      const client = await getClient();
      const result = await client.post<{ data: { id: string } }>('/helpdesk-analytics/charts', {
        reportId: source.reportId,
        title: `${source.title} (copy)`,
        ...(source.description ? { description: source.description } : {}),
        chartType: source.chartType,
        entity: source.entity,
        metric: source.metric,
        color: source.color,
        smoothCurve: source.smoothCurve,
        fillArea: source.fillArea,
        showDataLabels: source.showDataLabels,
        showLegend: source.showLegend,
        ...(source.timeRange ? { timeRange: source.timeRange } : {}),
        ...(source.groupBy ? { groupBy: source.groupBy } : {}),
        ...(source.aggregation ? { aggregation: source.aggregation } : {}),
        ...(source.sortOrder ? { sortOrder: source.sortOrder } : {}),
        ...(source.limit != null ? { limit: source.limit } : {}),
        ...(source.compareWith ? { compareWith: source.compareWith } : {}),
        layout: source.layout,
      });

      const newId = result.data?.id;
      if (!newId) return;

      const duplicated: AnalyticsChart = {
        ...source,
        id: newId,
        title: `${source.title} (copy)`,
      };
      setCharts((prev) => [...prev, duplicated]);
      setLayouts((prev) => [
        ...prev,
        {
          i: newId,
          x: source.layout?.x ?? 0,
          y: source.layout?.y ?? 0,
          w: source.layout?.w ?? 6,
          h: source.layout?.h ?? STANDARD_CHART_HEIGHT,
          minW: source.layout?.minW ?? 4,
          minH: source.layout?.minH ?? 4,
        },
      ]);
    });
  };

  // Open create report dialog
  const openCreateReportDialog = () => {
    setReportSelectorOpen(false);
    setNewReportTitle('');
    setNewReportDescription('');
    setCreateReportDialogOpen(true);
  };

  // Create a new report
  const handleCreateNewReport = async () => {
    if (!newReportTitle.trim()) return;

    startTransition(async () => {
      const client = await getClient();
      const title = newReportTitle.trim();
      const description = newReportDescription.trim() || 'Analytics report';
      // app-api create returns only { data: { id } }, not the full row that the
      // legacy route echoed back — so build the optimistic entry locally.
      const result = await client.post<{ data: { id: string } }>('/helpdesk-analytics', {
        title,
        description,
      });

      const newReport: AnalyticsReport = {
        id: result.data.id,
        title,
        description,
        chartCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setReports((prev) => [...prev, newReport]);
      setCreateReportDialogOpen(false);
      router.push(`/welddesk/analytics/${newReport.id}`);
    });
  };

  // Delete current report
  const deleteCurrentReport = async () => {
    startTransition(async () => {
      const client = await getClient();
      // Report delete is DELETE /helpdesk-analytics/:id on app-api; non-2xx
      // throws, so reaching the next line means it succeeded.
      await client.delete<{ data: { id: string } }>(`/helpdesk-analytics/${reportId}`);
      setReportSelectorOpen(false);
      const remainingReports = reports.filter((r) => r.id !== reportId);
      if (remainingReports.length > 0) {
        router.push(`/welddesk/analytics/${remainingReports[0].id}`);
      } else {
        router.push('/welddesk/analytics');
      }
    });
  };

  // Empty state - no charts
  if (charts.length === 0) {
    return (
      <div className="min-h-full bg-background">
        <div className="p-8 space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{pageTitle}</h1>
              <p className="text-muted-foreground mt-1">{pageDescription}</p>
            </div>
            <div className="flex gap-2">
              <Popover open={reportSelectorOpen} onOpenChange={setReportSelectorOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={reportSelectorOpen}
                    className="w-[200px] justify-between"
                  >
                    {reports.find((r) => r.id === reportId)?.title || t.helpdesk.analyticsReports.selectReport}
                    <ChevronsUpDown className="opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0">
                  <Command>
                    <CommandInput placeholder={t.helpdesk.analyticsReports.searchReport} className="h-9" />
                    <CommandList>
                      <CommandEmpty>{t.helpdesk.analyticsReports.noReportFound}</CommandEmpty>
                      <CommandGroup>
                        {reports.map((r) => (
                          <CommandItem
                            key={r.id}
                            value={r.title}
                            onSelect={() => {
                              router.push(`/welddesk/analytics/${r.id}`);
                              setReportSelectorOpen(false);
                            }}
                          >
                            {r.title}
                            <Check
                              className={cn(
                                "ml-auto",
                                reportId === r.id ? "opacity-100" : "opacity-0"
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                      <CommandSeparator />
                      <CommandGroup>
                        <CommandItem onSelect={openCreateReportDialog}>
                          <Plus className="mr-0.5 h-4 w-4" />
                          {t.helpdesk.analyticsReports.newReport}
                        </CommandItem>
                        <CommandItem
                          onSelect={deleteCurrentReport}
                          className="text-red-600 focus:text-red-600"
                        >
                          <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                          {t.helpdesk.analyticsReports.delete}
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <Button
                variant="outline"
                size="sm"
                className="shadow-none"
                onClick={() => router.push(`/welddesk/analytics/builder?reportId=${reportId}`)}
              >
                {t.helpdesk.analyticsReports.addChart}
              </Button>
            </div>
          </div>

          {/* Empty state */}
          <div className="flex flex-col items-center justify-center text-center px-6 min-h-[calc(100dvh-260px)]">
            <EmptyStateIllustration>
              <svg width="120" height="140" viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
                <rect x="16" y="22" width="80" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
                <rect x="16" y="22" width="80" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Chart bars */}
                <rect x="32" y="90" width="12" height="20" rx="2" className="fill-gray-200 dark:fill-white/20" />
                <rect x="50" y="75" width="12" height="35" rx="2" className="fill-gray-200 dark:fill-white/20" />
                <rect x="68" y="62" width="12" height="48" rx="2" className="fill-gray-200 dark:fill-white/20" />
                {/* Title lines */}
                <rect x="28" y="32" width="40" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
                <rect x="28" y="40" width="28" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
              </svg>
            </EmptyStateIllustration>
            <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{t.helpdesk.analyticsReports.noChartsYet}</h3>
            <p className="text-sm text-muted-foreground mb-5 max-w-[320px] leading-relaxed">{t.helpdesk.analyticsReports.addFirstChart}</p>
            <Button
              size="sm"
              className="bg-black hover:bg-gray-800 text-white"
              onClick={() => router.push(`/welddesk/analytics/builder?reportId=${reportId}`)}
            >
              <Plus className="h-4 w-4 mr-0.5" />
              {t.helpdesk.analyticsReports.addChart}
            </Button>
          </div>
        </div>

        {/* Create Report Dialog */}
        <Dialog open={createReportDialogOpen} onOpenChange={setCreateReportDialogOpen}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{t.helpdesk.analyticsReports.createNewReport}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="report-title-empty">{t.helpdesk.analyticsReports.reportTitle}</Label>
                <Input
                  id="report-title-empty"
                  placeholder={t.helpdesk.analyticsReports.reportTitlePlaceholder}
                  value={newReportTitle}
                  onChange={(e) => setNewReportTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateNewReport()}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="report-description-empty">{t.helpdesk.analyticsReports.reportDescription}</Label>
                <Input
                  id="report-description-empty"
                  placeholder={t.helpdesk.analyticsReports.reportDescriptionPlaceholder}
                  value={newReportDescription}
                  onChange={(e) => setNewReportDescription(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateNewReport()}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateReportDialogOpen(false)}>
                {t.helpdesk.analyticsReports.cancel}
              </Button>
              <Button onClick={handleCreateNewReport} disabled={!newReportTitle.trim() || isPending}>
                {isPending ? t.helpdesk.analyticsReports.creating : t.helpdesk.analyticsReports.createReport}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background">
      <div className="p-8 space-y-6">
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
                  <span className="text-3xl font-bold tracking-tight invisible whitespace-pre">{pageTitle || t.helpdesk.analyticsReports.pageTitle}</span>
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
                    placeholder={t.helpdesk.analyticsReports.pageTitle}
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
                  <span className="text-muted-foreground invisible whitespace-pre">{pageDescription || t.helpdesk.analyticsReports.pageDescription}</span>
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
                    placeholder={t.helpdesk.analyticsReports.pageDescription}
                  />
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground">{pageDescription}</p>
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={cancelLayoutChanges}
                  disabled={isPending}
                >
                  {t.helpdesk.analyticsReports.cancel}
                </Button>
                <Button
                  size="sm"
                  onClick={saveLayoutChanges}
                  disabled={!hasUnsavedChanges || isPending}
                >
                  {isPending ? t.helpdesk.analyticsReports.saving : t.helpdesk.analyticsReports.saveLayout}
                </Button>
              </>
            ) : (
              <>
                <Popover open={reportSelectorOpen} onOpenChange={setReportSelectorOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={reportSelectorOpen}
                      className="w-[200px] justify-between"
                    >
                      {reports.find((r) => r.id === reportId)?.title || t.helpdesk.analyticsReports.selectReport}
                      <ChevronsUpDown className="opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[200px] p-0">
                    <Command>
                      <CommandInput placeholder={t.helpdesk.analyticsReports.searchReport} className="h-9" />
                      <CommandList>
                        <CommandEmpty>{t.helpdesk.analyticsReports.noReportFound}</CommandEmpty>
                        <CommandGroup>
                          {reports.map((r) => (
                            <CommandItem
                              key={r.id}
                              value={r.title}
                              onSelect={() => {
                                router.push(`/welddesk/analytics/${r.id}`);
                                setReportSelectorOpen(false);
                              }}
                            >
                              {r.title}
                              <Check
                                className={cn(
                                  "ml-auto",
                                  reportId === r.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                        <CommandSeparator />
                        <CommandGroup>
                          <CommandItem onSelect={openCreateReportDialog}>
                            <Plus className="mr-0.5 h-4 w-4" />
                            {t.helpdesk.analyticsReports.newReport}
                          </CommandItem>
                          <CommandItem
                            onSelect={deleteCurrentReport}
                            className="text-red-600 focus:text-red-600"
                          >
                            <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                            {t.helpdesk.analyticsReports.delete}
                          </CommandItem>
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <Button
                  variant="outline"
                  size="sm"
                  className="shadow-none"
                  onClick={() => setIsEditMode(true)}
                >
                  {t.helpdesk.analyticsReports.edit}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="shadow-none"
                  onClick={() => router.push(`/welddesk/analytics/builder?reportId=${reportId}`)}
                >
                  {t.helpdesk.analyticsReports.addChart}
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
                {t.helpdesk.analyticsReports.editModeActive}
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
                {t.helpdesk.analyticsReports.custom}
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
          <GridLayoutFixed
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
            {charts.map((chart) => {
              const dynamicChartConfig = {
                value: {
                  label: chart.title || t.helpdesk.analyticsReports.chartTitle,
                  color: chart.color || "#3b82f6",
                },
              } satisfies ChartConfig;

              return (
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
                              {t.helpdesk.analyticsReports.duplicateChart}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => removeWidget(chart.id)}
                              className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/50"
                            >
                              <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                              {t.helpdesk.analyticsReports.deleteChart}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}

                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <CardTitle className="text-base">{chart.title}</CardTitle>
                          <CardDescription className="text-sm">{chart.description}</CardDescription>
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
                                  <CommandEmpty>{t.helpdesk.analyticsReports.noPeriodFound}</CommandEmpty>
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
                    <CardContent className="pb-2 pt-0 flex-1 min-h-[200px] overflow-hidden">
                      {isLoadingData && !chartData[chart.id] ? (
                        <div className="h-full w-full flex items-center justify-center">
                          <div className="text-sm text-muted-foreground">{t.helpdesk.analyticsReports.loadingData}</div>
                        </div>
                      ) : !chartData[chart.id] || chartData[chart.id].length === 0 ? (
                        <div className="h-full w-full flex flex-col items-center justify-center">
                          <p className="text-sm text-muted-foreground">{t.helpdesk.analyticsReports.noDataAvailable}</p>
                        </div>
                      ) : (
                        <ChartContainer config={dynamicChartConfig} className="h-full w-full">
                          {renderChart(chart, chartData[chart.id] || [], t.helpdesk.analyticsReports.total)}
                        </ChartContainer>
                      )}
                    </CardContent>
                  </Card>
                </div>
              );
            })}
          </GridLayoutFixed>
        </div>
      </div>

      {/* Create Report Dialog */}
      <Dialog open={createReportDialogOpen} onOpenChange={setCreateReportDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t.helpdesk.analyticsReports.createNewReport}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="report-title">{t.helpdesk.analyticsReports.reportTitle}</Label>
              <Input
                id="report-title"
                placeholder={t.helpdesk.analyticsReports.reportTitlePlaceholder}
                value={newReportTitle}
                onChange={(e) => setNewReportTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateNewReport()}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="report-description">{t.helpdesk.analyticsReports.reportDescription}</Label>
              <Input
                id="report-description"
                placeholder={t.helpdesk.analyticsReports.reportDescriptionPlaceholder}
                value={newReportDescription}
                onChange={(e) => setNewReportDescription(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateNewReport()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateReportDialogOpen(false)}>
              {t.helpdesk.analyticsReports.cancel}
            </Button>
            <Button onClick={handleCreateNewReport} disabled={!newReportTitle.trim() || isPending}>
              {isPending ? t.helpdesk.analyticsReports.creating : t.helpdesk.analyticsReports.createReport}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Helper function to render charts based on type
// Data format: { label: string, value: number, fill?: string, name?: string }
function renderChart(chart: AnalyticsChart, data: ChartDataPoint[], totalLabel: string = 'Total') {
  const hasData = data && data.length > 0;

  switch (chart.chartType) {
    case 'area-chart':
    case undefined:
      return (
        <AreaChart accessibilityLayer data={hasData ? data : []} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 7) : String(value)} />
          <ChartTooltip cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent labelFormatter={(value) => String(value)} />} />
          <Area dataKey="value" type={chart.smoothCurve ? "natural" : "linear"} fill={chart.fillArea ? chart.color : "transparent"} fillOpacity={chart.fillArea ? 0.2 : 0} stroke={chart.color} strokeWidth={2} dot={chart.showDataLabels} />
        </AreaChart>
      );

    case 'area-linear':
      return (
        <AreaChart accessibilityLayer data={hasData ? data : []} margin={{ left: 12, right: 12 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 7) : String(value)} />
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent indicator="dot" labelKey="label" />} />
          <Area dataKey="value" type="linear" fill={chart.color} fillOpacity={0.4} stroke={chart.color} />
        </AreaChart>
      );

    case 'area-stacked':
      // For stacked charts with real data, use single value for now
      return (
        <AreaChart accessibilityLayer data={hasData ? data : []} margin={{ left: 12, right: 12 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 7) : String(value)} />
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent indicator="dot" labelKey="label" />} />
          <Area dataKey="value" type="natural" fill={chart.color} fillOpacity={0.4} stroke={chart.color} />
        </AreaChart>
      );

    case 'bar-multiple':
      // For bar charts with real data, use single value
      return (
        <BarChart accessibilityLayer data={hasData ? data : []}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 7) : String(value)} />
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent indicator="dashed" />} />
          <Bar dataKey="value" fill={chart.color} radius={4} />
        </BarChart>
      );

    case 'bar-mixed':
      return (
        <BarChart accessibilityLayer data={hasData ? data : []} layout="vertical" margin={{ left: 0 }}>
          <YAxis dataKey="label" type="category" tickLine={false} tickMargin={10} axisLine={false} width={80} />
          <XAxis dataKey="value" type="number" hide />
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent hideLabel />} />
          <Bar dataKey="value" layout="vertical" radius={5} />
        </BarChart>
      );

    case 'bar-stacked':
      // For stacked bar charts with real data, use single value
      return (
        <BarChart accessibilityLayer data={hasData ? data : []}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 7) : String(value)} />
          <ChartTooltip wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent hideLabel />} />
          <Bar dataKey="value" fill={chart.color} radius={4} />
        </BarChart>
      );

    case 'bar-negative':
      return (
        <BarChart accessibilityLayer data={hasData ? data : []}>
          <CartesianGrid vertical={false} />
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent hideLabel hideIndicator />} />
          <Bar dataKey="value">
            <LabelList position="top" dataKey="label" fillOpacity={1} />
            {(hasData ? data : []).map((item: ChartDataPoint, index: number) => (
              <Cell key={item.label || index} fill={item.value > 0 ? "var(--chart-1)" : "var(--chart-2)"} />
            ))}
          </Bar>
        </BarChart>
      );

    case 'pie-label':
      return (
        <PieChart>
          <ChartTooltip wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent nameKey="name" hideLabel />} />
          <Pie data={hasData ? data : []} dataKey="value" nameKey="name">
            <LabelList dataKey="label" className="fill-background" stroke="none" fontSize={12} />
          </Pie>
        </PieChart>
      );

    case 'pie-donut':
      return (
        <PieChart>
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent hideLabel />} />
          <Pie data={hasData ? data : []} dataKey="value" nameKey="name" innerRadius={60} strokeWidth={5}>
            <RechartsLabel
              content={({ viewBox }) => {
                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                  const total = Array.isArray(data) ? data.reduce((acc: number, curr: ChartDataPoint) => acc + (curr.value || 0), 0) : 0;
                  return (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-3xl font-bold">{total.toLocaleString()}</tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 24} className="fill-muted-foreground">{totalLabel}</tspan>
                    </text>
                  );
                }
              }}
            />
          </Pie>
        </PieChart>
      );

    case 'radar-lines':
      return (
        <RadarChart data={hasData ? data : []}>
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent indicator="line" />} />
          <PolarAngleAxis dataKey="label" />
          <PolarGrid radialLines={false} />
          <Radar dataKey="value" fill={chart.color} fillOpacity={0} stroke={chart.color} strokeWidth={2} />
        </RadarChart>
      );

    case 'radial-simple':
      return (
        <RadialBarChart data={hasData ? data : []} innerRadius={30} outerRadius={110}>
          <ChartTooltip cursor={false} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent hideLabel nameKey="name" />} />
          <RadialBar dataKey="value" background />
        </RadialBarChart>
      );

    case 'radial-text':
      return (
        <RadialBarChart data={hasData && data.length > 0 ? [data[0]] : []} startAngle={0} endAngle={250} innerRadius={80} outerRadius={110}>
          <PolarGrid gridType="circle" radialLines={false} stroke="none" className="first:fill-muted last:fill-background" polarRadius={[86, 74]} />
          <RadialBar dataKey="value" background cornerRadius={10} />
          <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
            <RechartsLabel
              content={({ viewBox }) => {
                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                  const value = hasData && data.length > 0 ? (data[0]?.value || 0) : 0;
                  return (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-4xl font-bold">{value.toLocaleString()}</tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 24} className="fill-muted-foreground">{totalLabel}</tspan>
                    </text>
                  );
                }
              }}
            />
          </PolarRadiusAxis>
        </RadialBarChart>
      );

    default:
      return (
        <AreaChart accessibilityLayer data={hasData ? data : []} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value) => typeof value === 'string' ? value.slice(0, 7) : String(value)} />
          <ChartTooltip cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }} wrapperStyle={{ zIndex: 1000, outline: 'none' }} content={<ChartTooltipContent labelFormatter={(value) => String(value)} />} />
          <Area dataKey="value" type="natural" fill={chart.color} fillOpacity={0.2} stroke={chart.color} strokeWidth={2} />
        </AreaChart>
      );
  }
}
