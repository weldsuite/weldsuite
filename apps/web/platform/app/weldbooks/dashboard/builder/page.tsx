/**
 * The WeldBooks chart builder, laid out like WeldFlow's: the chart previewed
 * on the left, drawn exactly as it will sit in "Your overview", and its
 * settings on the right. `?chartId=` edits one of the user's charts; without
 * it the builder adds a new one. Saving goes back to the dashboard.
 */

import { useMemo, useState } from 'react';
import { AreaChart, BarChart3, ChevronDown, LineChart, Rows3, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageColumn } from '@weldsuite/ui/components/page-layout';
import { useAccountingDashboard } from '@/hooks/queries/use-accounting-queries';
import { useDashboardCharts } from '@/hooks/queries/use-weldbooks-dashboard-charts';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { ChartColorField } from '../components/chart-color-field';
import { CustomChartBody, useChartHeading, useSourceLabels } from '../components/custom-chart-card';
import {
  BREAKDOWN_SOURCES,
  CHART_COMPARES,
  CHART_RANGES,
  TREND_SOURCES,
  chartTypesFor,
  isTrendSource,
  newDashboardChart,
  type ChartCompare,
  type ChartRange,
  type ChartSource,
  type ChartType,
  type DashboardChart,
} from '../components/custom-charts';
import { dashboardTrend } from '../components/dashboard-series';
import { OverviewCard } from '../components/overview-card';

const DASHBOARD_PATH = '/weldbooks/dashboard';
/** What a chart set to "Same as dashboard" previews with: the overview's defaults. */
const PREVIEW_FILTER = { size: 12, compare: 'previousPeriod' as const };
const TYPE_ICONS: Record<ChartType, LucideIcon> = { line: LineChart, area: AreaChart, bar: BarChart3, breakdown: Rows3 };

export default function DashboardChartBuilderPage() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const chartId = searchParams.get('chartId');
  const { data, isLoading } = useAccountingDashboard();
  const { charts, isLoading: chartsLoading } = useDashboardCharts();

  if (isLoading || chartsLoading) return <PageLoader fullScreen={false} />;
  const dashboard = data?.data;
  if (!dashboard) {
    return <PageColumn className="py-6 text-muted-foreground">{t.accounting.dashboard.loadingMessage}</PageColumn>;
  }
  const existing = chartId ? charts.find((c) => c.id === chartId) : undefined;
  if (chartId && !existing) {
    return <PageColumn className="py-6 text-muted-foreground">{t.accounting.dashboard.builder.notFound}</PageColumn>;
  }
  return <ChartBuilder key={chartId ?? 'new'} dashboard={dashboard} initial={existing} />;
}

function ChartBuilder({ dashboard, initial }: Readonly<{ dashboard: Dashboard; initial?: DashboardChart }>) {
  const { t } = useI18n();
  const tb = t.accounting.dashboard.builder;
  const tc = t.accounting.dashboard.charts;
  const router = useRouter();
  const sourceLabels = useSourceLabels();
  const sourceInfo: Record<ChartSource, string> = tc.info;
  const { saveChart, isSaving } = useDashboardCharts();
  const [chart, setChart] = useState<DashboardChart>(() => initial ?? newDashboardChart());
  const { months, sample } = useMemo(() => dashboardTrend(dashboard), [dashboard]);
  const editing = Boolean(initial);
  const trend = isTrendSource(chart.source);
  const types = chartTypesFor(chart.source);

  const update = (patch: Partial<DashboardChart>) => setChart((c) => ({ ...c, ...patch }));
  const setSource = (source: ChartSource) => {
    const allowed = chartTypesFor(source);
    update({ source, type: allowed.includes(chart.type) ? chart.type : allowed[0] });
  };

  const typeLabels: Record<ChartType, string> = tb.types;
  const rangeLabels: Record<ChartRange, string> = {
    dashboard: tb.followDashboard,
    '3': tc.last3Months,
    '6': tc.last6Months,
    '12': tc.last12Months,
    '24': tb.last24Months,
  };
  const compareLabels: Record<ChartCompare, string> = {
    dashboard: tb.followDashboard,
    previousPeriod: tc.previousPeriod,
    previousYear: tc.previousYear,
    off: tc.compareOff,
  };

  const close = () => router.push(DASHBOARD_PATH);
  const save = async () => {
    try {
      await saveChart({ ...chart, title: chart.title.trim(), description: chart.description.trim() });
      toast.success(tb.chartSaved);
      close();
    } catch {
      toast.error(tb.saveFailed);
    }
  };

  const TypeIcon = TYPE_ICONS[chart.type];
  const { title, info } = useChartHeading(chart);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-[560px] overflow-hidden">
      {/* Preview */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-background">
        {/* Laid over the preview, so the chart centres on the whole area, this row included. */}
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between p-6">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" aria-label={tb.typeLabel}>
                <TypeIcon className="size-4" aria-hidden />
                {typeLabels[chart.type]}
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              <DropdownMenuRadioGroup value={chart.type} onValueChange={(v) => update({ type: v as ChartType })}>
                {types.map((type) => {
                  const Icon = TYPE_ICONS[type];
                  return (
                    <DropdownMenuRadioItem key={type} value={type}>
                      <Icon aria-hidden />
                      {typeLabels[type]}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Badge variant="secondary">{tb.preview}</Badge>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-8 py-20">
          <div className="w-full max-w-[352px]">
            <OverviewCard title={title} info={info}>
              <CustomChartBody chart={chart} dashboard={dashboard} months={months} sample={sample} filter={PREVIEW_FILTER} />
            </OverviewCard>
          </div>
        </div>
      </div>

      {/* Settings */}
      <aside className="flex w-[360px] shrink-0 flex-col border-l bg-background">
        <div className="flex items-center justify-between gap-2 border-b px-5 py-4">
          <h1 className="text-sm font-semibold">{editing ? tb.editChart : tb.configuration}</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={close}>
              {tb.close}
            </Button>
            <Button size="sm" onClick={save} disabled={isSaving}>
              {editing ? tb.save : tb.addChart}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <FieldGroup>
            <FieldSet>
              <FieldLegend>{tb.basicInformation}</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="chart-title">{tb.titleLabel}</FieldLabel>
                  <Input
                    id="chart-title"
                    value={chart.title}
                    maxLength={80}
                    placeholder={sourceLabels[chart.source]}
                    onChange={(e) => update({ title: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="chart-description">{tb.descriptionLabel}</FieldLabel>
                  <Textarea
                    id="chart-description"
                    value={chart.description}
                    maxLength={200}
                    placeholder={sourceInfo[chart.source]}
                    onChange={(e) => update({ description: e.target.value })}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>{tb.dataSource}</FieldLegend>
              <Field>
                <FieldLabel htmlFor="chart-source">{tb.sourceLabel}</FieldLabel>
                <Select value={chart.source} onValueChange={(v) => setSource(v as ChartSource)}>
                  <SelectTrigger id="chart-source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{tb.trendGroup}</SelectLabel>
                      {TREND_SOURCES.map((source) => (
                        <SelectItem key={source} value={source}>
                          {sourceLabels[source]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>{tb.breakdownGroup}</SelectLabel>
                      {BREAKDOWN_SOURCES.map((source) => (
                        <SelectItem key={source} value={source}>
                          {sourceLabels[source]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>{tb.period}</FieldLegend>
              {trend ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="chart-range">{tc.dateRange}</FieldLabel>
                    <Select value={chart.range} onValueChange={(v) => update({ range: v as ChartRange })}>
                      <SelectTrigger id="chart-range" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CHART_RANGES.map((range) => (
                          <SelectItem key={range} value={range}>
                            {rangeLabels[range]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="chart-compare">{tb.compareLabel}</FieldLabel>
                    <Select value={chart.compare} onValueChange={(v) => update({ compare: v as ChartCompare })}>
                      <SelectTrigger id="chart-compare" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CHART_COMPARES.map((compare) => (
                          <SelectItem key={compare} value={compare}>
                            {compareLabels[compare]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
              ) : (
                <FieldDescription>{tb.asOfToday}</FieldDescription>
              )}
            </FieldSet>

            {trend && (
              <>
                <FieldSeparator />
                <FieldSet>
                  <FieldLegend>{tb.appearance}</FieldLegend>
                  <Field>
                    <FieldLabel htmlFor="chart-color">{tb.colorLabel}</FieldLabel>
                    <ChartColorField id="chart-color" value={chart.color} onChange={(color) => update({ color })} />
                  </Field>
                </FieldSet>
              </>
            )}
          </FieldGroup>
        </div>
      </aside>
    </div>
  );
}
