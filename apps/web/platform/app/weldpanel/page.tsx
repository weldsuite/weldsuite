import { useMemo, useState } from 'react';
import { ChartSpline, Code, Filter, Plus, PlayCircle } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import type { PanelBreakdownRow, PanelFilter, PanelFilterColumn, PanelWebSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useWeldPanelLive, useWeldPanelWeb } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { AnalyticsPage } from './components/analytics-page';
import { BreakdownList, type BreakdownListRow } from './components/breakdown-list';
import { ChartCard } from './components/chart-card';
import { CreateProjectDialog } from './components/create-project-dialog';
import { DateRangePicker } from './components/date-range-picker';
import { FilterBuilder } from './components/filter-builder';
import { FreshnessBadge } from './components/freshness-badge';
import { InstallStatus } from './components/install-status';
import { QueryErrorState } from './components/query-error-state';
import { WebChart, WebKpis } from './components/results/web-result';
import { browserTimezone, useDateRange } from './lib/date-range';
import { countryName } from './lib/format';
import { toggleColumnFilter } from './lib/filters';
import { isAnalyticsUnavailable } from './lib/query-error';
import { useCurrentProject } from './lib/use-current-project';

type PagesTab = 'top' | 'entry' | 'exit';
type SourcesTab = 'referrers' | 'utmSource' | 'utmMedium' | 'utmCampaign';
type DevicesTab = 'devices' | 'browsers' | 'operatingSystems';

/** Which column a row of each list filters on. */
const SOURCE_COLUMN: Record<SourcesTab, PanelFilterColumn> = {
  referrers: 'referrer_host',
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
};
const DEVICE_COLUMN: Record<DevicesTab, PanelFilterColumn> = { devices: 'device_type', browsers: 'browser', operatingSystems: 'os' };

function selectedValues(filters: readonly PanelFilter[], field: PanelFilterColumn): string[] {
  return filters.flatMap((f) => (f.source === 'column' && f.field === field && f.operator === 'eq' && typeof f.value === 'string' ? [f.value] : []));
}

function LiveVisitors({ projectId }: Readonly<{ projectId: string }>) {
  const { t, format } = useI18n();
  const to = t.weldpanel.analytics.overview;
  const { data } = useWeldPanelLive(projectId);
  if (!data) return null;
  const online = data.visitors > 0;
  return (
    <Link href="/weldpanel/live" className="flex items-center gap-2 rounded-md border px-3 py-1 text-sm hover:bg-muted" title={to.liveHint}>
      <span className={online ? 'size-2 animate-pulse rounded-full bg-emerald-500' : 'size-2 rounded-full bg-muted-foreground/40'} aria-hidden />
      <span>{online ? format(to.live, { count: data.visitors }) : to.liveNone}</span>
    </Link>
  );
}

function Overview({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t, language } = useI18n();
  const to = t.weldpanel.analytics.overview;
  const [range, setRange] = useDateRange();
  const [filters, setFilters] = useState<PanelFilter[]>([]);
  const [compare, setCompare] = useState(true);
  const [pagesTab, setPagesTab] = useState<PagesTab>('top');
  const [sourcesTab, setSourcesTab] = useState<SourcesTab>('referrers');
  const [devicesTab, setDevicesTab] = useState<DevicesTab>('devices');

  const spec = useMemo<PanelWebSpec>(
    () => ({ kind: 'web', projectId: project.id, dateRange: range, filters, compare, limit: 10, timezone: browserTimezone() }),
    [project.id, range, filters, compare],
  );
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelWeb(spec);
  const result = data?.result;

  const noTraffic = result !== undefined && result.totals.pageviews === 0 && result.totals.visitors === 0;
  const unavailable = isAnalyticsUnavailable(error);

  const pickFilter = (field: PanelFilterColumn) => (value: string) => {
    if (value !== '') setFilters((current) => toggleColumnFilter(current, field, value));
  };

  const labelFor = (field: PanelFilterColumn, value: string): string => {
    if (value === '') return field === 'referrer_host' ? to.sources.direct : t.weldpanel.analytics.common.unknown;
    if (field === 'country') return countryName(value, language);
    if (field === 'device_type' && (value === 'desktop' || value === 'mobile' || value === 'tablet')) return to.devices[value];
    return value;
  };

  const breakdownRows = (rows: PanelBreakdownRow[] | undefined, field: PanelFilterColumn): BreakdownListRow[] =>
    (rows ?? []).map((row) => ({ key: row.value, label: labelFor(field, row.value), primary: row.visitors, secondary: row.events }));

  const pagesRows: BreakdownListRow[] = useMemo(() => {
    if (!result) return [];
    if (pagesTab === 'top') return result.topPages.map((r) => ({ key: r.value, label: r.value, primary: r.visitors, secondary: r.events }));
    return result.entryExitPages
      .filter((r) => (pagesTab === 'entry' ? r.entries > 0 : r.exits > 0))
      .sort((a, b) => (pagesTab === 'entry' ? b.entries - a.entries : b.exits - a.exits))
      .map((r) => ({ key: r.value, label: r.value, primary: pagesTab === 'entry' ? r.entries : r.exits }));
  }, [result, pagesTab]);

  const sourcesRows = result
    ? breakdownRows(
        { referrers: result.sources, utmSource: result.utmSources, utmMedium: result.utmMediums, utmCampaign: result.utmCampaigns }[sourcesTab],
        SOURCE_COLUMN[sourcesTab],
      )
    : [];
  const devicesRows = result
    ? breakdownRows({ devices: result.devices, browsers: result.browsers, operatingSystems: result.operatingSystems }[devicesTab], DEVICE_COLUMN[devicesTab])
    : [];

  // The page title row belongs to AnalyticsPage; the toolbar opens the body.
  const toolbar = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <LiveVisitors projectId={project.id} />
      <DateRangePicker value={range} onChange={setRange} />
    </div>
  );

  if (unavailable) {
    return (
      <>
        {toolbar}
        <QueryErrorState error={error} />
        <InstallStatus projectId={project.id} paused={project.status === 'paused'} showLink />
      </>
    );
  }

  // A project that never received an event: the install instructions, not a page of zeros.
  if (noTraffic && filters.length === 0 && !isFetching) {
    return (
      <>
        {toolbar}
        <InstallStatus projectId={project.id} paused={project.status === 'paused'} showLink />
        <EmptyState icon={ChartSpline} title={to.waitingTitle} description={to.waitingDescription} />
      </>
    );
  }

  const tabsList = <T extends string>(value: T, onChange: (next: T) => void, items: { value: T; label: string }[], label: string) => (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList className="h-7" aria-label={label}>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value} className="px-2 text-xs">
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  const rowLabel = to.filterRow;

  return (
    <>
      {toolbar}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBuilder projectId={project.id} filters={filters} onChange={setFilters} />
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="weldpanel-compare" checked={compare} onCheckedChange={setCompare} />
            <Label htmlFor="weldpanel-compare" className="text-sm font-normal">
              {t.weldpanel.analytics.range.compare}
            </Label>
          </div>
          <FreshnessBadge dataAsOf={data?.dataAsOf} cached={data?.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={result?.range.clampedToRetention} />
        </div>
      </div>

      {error ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <WebKpis result={result} loading={isLoading} />

          <ChartCard title={to.chart.title} loading={isLoading} empty={result !== undefined && result.series.length === 0}>
            {result && <WebChart result={result} />}
          </ChartCard>

          <p className="-mb-3 text-xs text-muted-foreground">{to.clickToFilter}</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title={to.pages.title}
              loading={isLoading}
              actions={tabsList(pagesTab, setPagesTab, [
                { value: 'top', label: to.pages.top },
                { value: 'entry', label: to.pages.entry },
                { value: 'exit', label: to.pages.exit },
              ], to.pages.title)}
            >
              <BreakdownList
                rows={pagesRows}
                primaryLabel={{ top: to.columns.visitors, entry: to.pages.entries, exit: to.pages.exits }[pagesTab]}
                secondaryLabel={pagesTab === 'top' ? to.columns.pageviews : undefined}
                selectedKeys={selectedValues(filters, 'path')}
                onSelect={pickFilter('path')}
                rowLabel={rowLabel}
                emptyText={t.weldpanel.analytics.common.noData}
              />
            </ChartCard>

            <ChartCard
              title={to.sources.title}
              loading={isLoading}
              actions={tabsList(sourcesTab, setSourcesTab, [
                { value: 'referrers', label: to.sources.referrers },
                { value: 'utmSource', label: to.sources.utmSource },
                { value: 'utmMedium', label: to.sources.utmMedium },
                { value: 'utmCampaign', label: to.sources.utmCampaign },
              ], to.sources.title)}
            >
              <BreakdownList
                rows={sourcesRows}
                primaryLabel={to.columns.visitors}
                secondaryLabel={to.columns.pageviews}
                selectedKeys={selectedValues(filters, SOURCE_COLUMN[sourcesTab])}
                onSelect={pickFilter(SOURCE_COLUMN[sourcesTab])}
                rowLabel={rowLabel}
                emptyText={t.weldpanel.analytics.common.noData}
              />
            </ChartCard>

            <ChartCard title={to.countries.title} loading={isLoading}>
              <BreakdownList
                rows={breakdownRows(result?.countries, 'country')}
                primaryLabel={to.columns.visitors}
                secondaryLabel={to.columns.pageviews}
                selectedKeys={selectedValues(filters, 'country')}
                onSelect={pickFilter('country')}
                rowLabel={rowLabel}
                emptyText={t.weldpanel.analytics.common.noData}
              />
            </ChartCard>

            <ChartCard
              title={to.devices.title}
              loading={isLoading}
              actions={tabsList(devicesTab, setDevicesTab, [
                { value: 'devices', label: to.devices.devices },
                { value: 'browsers', label: to.devices.browsers },
                { value: 'operatingSystems', label: to.devices.operatingSystems },
              ], to.devices.title)}
            >
              <BreakdownList
                rows={devicesRows}
                primaryLabel={to.columns.visitors}
                secondaryLabel={to.columns.pageviews}
                selectedKeys={selectedValues(filters, DEVICE_COLUMN[devicesTab])}
                onSelect={pickFilter(DEVICE_COLUMN[devicesTab])}
                rowLabel={rowLabel}
                emptyText={t.weldpanel.analytics.common.noData}
              />
            </ChartCard>
          </div>
        </>
      )}
    </>
  );
}

/**
 * WeldPanel home: the Overview, a Plausible-style web analytics dashboard for
 * the current project. Without a project it offers to create one.
 */
export default function WeldPanelHome() {
  const { t } = useI18n();
  const th = t.weldpanel.home;
  const canCreate = useCan('panel_projects:create');
  const { projects, isLoading, isError, refetch } = useCurrentProject();
  const [creating, setCreating] = useState(false);

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  if (isError) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 p-10">
        <ErrorState message={th.loadFailed} onRetry={refetch} retryLabel={t.weldpanel.retry} />
      </div>
    );
  }

  if (projects.length > 0) {
    return <AnalyticsPage title={t.weldpanel.analytics.overview.title} description={t.weldpanel.analytics.overview.description}>{(project) => <Overview key={project.id} project={project} />}</AnalyticsPage>;
  }

  const steps = [
    { icon: Code, ...th.steps.install },
    { icon: Filter, ...th.steps.analyse },
    { icon: PlayCircle, ...th.steps.watch },
  ];

  const newProjectButton = canCreate && (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus />
      {th.newProject}
    </Button>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{th.title}</h1>
        <p className="text-sm text-muted-foreground">{th.description}</p>
      </div>

      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center">
        <ChartSpline className="size-8 text-muted-foreground" />
        <p className="font-medium">{th.emptyTitle}</p>
        <p className="max-w-md text-sm text-muted-foreground">{th.emptyDescription}</p>
        {canCreate ? <div className="mt-2">{newProjectButton}</div> : <p className="max-w-md text-sm text-muted-foreground">{th.emptyNoCreate}</p>}
      </div>

      <ol className="grid gap-4 sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, description }) => (
          <li key={title} className="flex gap-3 rounded-lg border bg-card p-4">
            <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{title}</p>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          </li>
        ))}
      </ol>

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
