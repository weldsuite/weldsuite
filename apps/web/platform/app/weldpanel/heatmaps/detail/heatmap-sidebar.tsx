/**
 * The column on the right of a heatmap, 400px like the recording page's:
 *
 * - Elements: the clicked elements ranked by clicks, as the standard list
 *   (search, a Clicks filter, Element / Clicks rows with their rank).
 * - Scroll depth: how many visitors reach each depth of the page.
 * - Info: the page group and the figures of the heatmap on screen.
 * - AI summary: themes in recent recorded visits to these pages (`ai-summary-panel.tsx`).
 *
 * Elements and Scroll depth ask for their own heatmap type (`area` and
 * `scroll`), so they show whichever type the heat layer is drawing.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  CalendarClock,
  CalendarPlus,
  Eye,
  FileStack,
  Info,
  Link2,
  LogOut,
  Monitor,
  MousePointerClick,
  Sparkles,
  Tag,
  TriangleAlert,
} from 'lucide-react';
import type { PanelHeatmapPageDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelDeviceClass, PanelHeatmapElement, PanelHeatmapResult, PanelHeatmapSpec, PanelHeatmapType } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { RecordingTabPanel, RecordingTabStrip } from '@weldsuite/ui/components/recording-layout';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { ActivityIllustration, TAB_EMPTY_STATE_TABLE_CLASS } from '@/components/objects/_shared/tab-empty-state';
import { PanelRow, PanelSection } from '@/components/objects/_shared/record-panel-parts';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useWeldPanelHeatmap } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { formatDate, formatNumber, formatPercent } from '../../lib/format';
import { averageFold } from '../../lib/heatmap';
import { HeatmapAiSummary } from './ai-summary-panel';

type SidebarTab = 'elements' | 'scroll' | 'info' | 'ai';

interface ElementRow {
  id: string;
  rank: number;
  name: string;
  selector: string;
  clicks: number;
  share: number;
}

interface DepthRow {
  id: string;
  depth: number;
  reachedShare: number;
}

/** A rank in the 20px slot before a row's name, like the recording's page steps. */
function Rank({ value }: Readonly<{ value: number }>) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
      {value}
    </span>
  );
}

/** Whether a row passes a "Clicks" filter: more (`gt`) or fewer (`lt`) than a number. */
function matchesClicks(row: ElementRow, operator: string, raw: string): boolean {
  const count = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(count)) return true;
  return operator === 'lt' ? row.clicks < count : row.clicks > count;
}

function ElementsPanel({ elements, loading }: Readonly<{ elements: readonly PanelHeatmapElement[]; loading: boolean }>) {
  const { t, language } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const items = useMemo<ElementRow[]>(
    () =>
      [...elements]
        .sort((a, b) => b.clicks - a.clicks)
        .map((element, index) => ({
          id: element.selector,
          rank: index + 1,
          name: element.text || element.selector,
          selector: element.selector,
          clicks: element.clicks,
          share: element.share,
        })),
    [elements],
  );
  const filters = useMemo<FilterConfig[]>(() => [{ field: 'clicks', label: th.clicksCol, filterType: 'number', operators: ['gt', 'lt'], options: [] }], [th]);
  const applyFilters = useCallback((list: ElementRow[], active: ActiveFilter[]) => {
    const set = active.filter((f) => f.field === 'clicks' && f.operator && f.value !== '');
    return list.filter((row) => set.every((f) => matchesClicks(row, f.operator, f.value)));
  }, []);
  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'element', header: th.elementCol, width: 'flex-1' },
      { id: 'clicks', header: th.clicksCol, width: 'w-[96px]', className: 'text-right' },
    ],
    [th],
  );
  const renderRow = useCallback(
    (item: ElementRow) => (
      <TabListRow key={item.id} label={item.name}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Rank value={item.rank} />
          <span className="truncate text-sm font-medium" title={item.selector}>
            {item.name}
          </span>
        </div>
        <span className="w-[96px] shrink-0 text-right text-sm tabular-nums">
          {formatNumber(item.clicks, language)}
          <span className="ml-1.5 text-xs text-muted-foreground">{formatPercent(item.share, language)}</span>
        </span>
      </TabListRow>
    ),
    [language],
  );

  return (
    <TabListScope>
      <EntityList<ElementRow>
        items={items}
        isLoading={loading}
        error={null}
        filters={filters}
        maxFilters={2}
        applyFilters={applyFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={th.searchElements}
        searchFields={['name', 'selector']}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <ActivityIllustration />, title: th.tabs.elements, description: th.noElements }}
      />
    </TabListScope>
  );
}

function ScrollPanel({ result, loading }: Readonly<{ result: PanelHeatmapResult | undefined; loading: boolean }>) {
  const { t, format, language } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const items = useMemo<DepthRow[]>(
    () => (result?.scroll.buckets ?? []).map((bucket) => ({ id: String(bucket.depth), depth: bucket.depth, reachedShare: bucket.reachedShare })),
    [result],
  );
  const fold = result ? averageFold(result.scroll.buckets) : null;
  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'depth', header: th.depthCol, width: 'flex-1' },
      { id: 'reached', header: th.reachedCol, width: 'w-[96px]', className: 'text-right' },
    ],
    [th],
  );
  const renderRow = useCallback(
    (item: DepthRow) => (
      <TabListRow key={item.id} label={format(th.depthLabel, { depth: item.depth })}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="w-10 shrink-0 text-sm tabular-nums">{formatPercent(item.depth / 100, language)}</span>
          {/* How far down the page, as a bar. */}
          <span className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className="block h-full rounded-full bg-sky-500" style={{ width: `${Math.min(item.depth, 100)}%` }} />
          </span>
        </div>
        <span className="w-[96px] shrink-0 text-right text-sm tabular-nums">{formatPercent(item.reachedShare, language)}</span>
      </TabListRow>
    ),
    [format, language, th],
  );

  return (
    <div className="grid">
      {result && (
        <p className="border-b px-4 py-3 text-sm text-muted-foreground">{fold === null ? th.scrollAll : format(th.scrollSummary, { depth: fold })}</p>
      )}
      <TabListScope>
        <EntityList<DepthRow>
          items={items}
          isLoading={loading}
          error={null}
          // Ten depths in order: nothing to filter. EntityList's pills need the list, empty.
          filters={[]}
          headerColumns={headerColumns}
          renderRow={renderRow}
          emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
          emptyState={{ icon: <ActivityIllustration />, title: th.tabs.scroll, description: th.noScroll }}
        />
      </TabListScope>
    </div>
  );
}

function InfoPanel({ group, result, type, deviceClass, unresolved }: Readonly<{ group: PanelHeatmapPageDto; result: PanelHeatmapResult | undefined; type: PanelHeatmapType; deviceClass: PanelDeviceClass; unresolved: number }>) {
  const { t, language } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const count = (value: number | undefined) => (value === undefined ? null : formatNumber(value, language));
  return (
    <div className="grid gap-6 p-4">
      <PanelSection title={th.info.pageGroup}>
        <div>
          <PanelRow icon={Tag} label={th.columns.name} value={group.name} />
          <PanelRow
            icon={Link2}
            label={th.columns.pattern}
            value={group.urlPattern}
            renderValue={(value) => <span className="block truncate font-mono text-xs">{value}</span>}
          />
          <PanelRow icon={CalendarPlus} label={th.info.created} value={formatDate(group.createdAt, language)} />
          <PanelRow icon={CalendarClock} label={th.columns.updated} value={formatDate(group.updatedAt, language)} />
        </div>
      </PanelSection>
      <PanelSection title={th.info.heatmap}>
        <div>
          <PanelRow icon={Monitor} label={th.device} value={t.weldpanel.observe.common.devices[deviceClass]} />
          <PanelRow icon={Eye} label={th.type} value={th.types[type]} />
          <PanelRow icon={FileStack} label={th.stats.pageviews} value={count(result?.pageviews)} tabular />
          {type === 'scroll' ? (
            <PanelRow icon={LogOut} label={th.stats.leaves} value={count(result?.scroll.leaves)} tabular />
          ) : (
            <PanelRow icon={MousePointerClick} label={th.stats.clicks} value={count(result?.clicks)} tabular />
          )}
          <PanelRow icon={TriangleAlert} label={th.stats.unresolved} value={formatNumber(unresolved, language)} tabular />
        </div>
      </PanelSection>
    </div>
  );
}

export interface HeatmapSidebarProps {
  group: PanelHeatmapPageDto;
  /** The heat layer's question; the tabs ask for their own type with it. */
  spec: PanelHeatmapSpec;
  /** The heat layer's answer, for Info. */
  result: PanelHeatmapResult | undefined;
  unresolved: number;
  /** The project's AI switch, for the AI summary. */
  aiEnabled: boolean;
}

export function HeatmapSidebar({ group, spec, result, unresolved, aiEnabled }: Readonly<HeatmapSidebarProps>) {
  const { t } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const idPrefix = useId();
  const [tab, setTab] = useState<SidebarTab>('elements');
  const areas = useWeldPanelHeatmap(useMemo(() => ({ ...spec, type: 'area' as const }), [spec]), { enabled: tab === 'elements' });
  const scroll = useWeldPanelHeatmap(useMemo(() => ({ ...spec, type: 'scroll' as const }), [spec]), { enabled: tab === 'scroll' });
  const tabs = [
    { id: 'elements', label: th.tabs.elements, icon: MousePointerClick },
    { id: 'scroll', label: th.tabs.scroll, icon: ArrowDownUp },
    { id: 'info', label: th.tabs.info, icon: Info },
    { id: 'ai', label: th.tabs.ai, icon: Sparkles },
  ];

  return (
    <>
      {/* 53px, level with the toolbar beside it. */}
      <RecordingTabStrip tabs={tabs} value={tab} onValueChange={(next) => setTab(next as SidebarTab)} label={th.tabs.label} idPrefix={idPrefix} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RecordingTabPanel idPrefix={idPrefix} value="elements" selected={tab === 'elements'}>
          {areas.error ? (
            <p className="p-4 text-sm text-destructive">{th.dataLoadFailed}</p>
          ) : (
            <ElementsPanel elements={areas.data?.result.elements ?? []} loading={areas.isLoading} />
          )}
        </RecordingTabPanel>
        <RecordingTabPanel idPrefix={idPrefix} value="scroll" selected={tab === 'scroll'}>
          {scroll.error ? <p className="p-4 text-sm text-destructive">{th.dataLoadFailed}</p> : <ScrollPanel result={scroll.data?.result} loading={scroll.isLoading} />}
        </RecordingTabPanel>
        <RecordingTabPanel idPrefix={idPrefix} value="info" selected={tab === 'info'}>
          {result ? (
            <InfoPanel group={group} result={result} type={spec.type} deviceClass={spec.deviceClass} unresolved={unresolved} />
          ) : (
            <div className="p-4">
              <Skeleton className="h-48 w-full" />
            </div>
          )}
        </RecordingTabPanel>
        <RecordingTabPanel idPrefix={idPrefix} value="ai" selected={tab === 'ai'}>
          <HeatmapAiSummary spec={spec} urlPattern={group.urlPattern} aiEnabled={aiEnabled} />
        </RecordingTabPanel>
      </div>
    </>
  );
}
