/**
 * Stripe's "Your overview": the heading with the date range and compare menus
 * on the same line, then a grid of charts straight on the page, no backdrop or
 * borders.
 *
 * - Revenue, expenses and net profit are line charts over the chosen range:
 *   the total, its change against the comparison and the comparison's total,
 *   then the chart. The pills drive every chart that follows the dashboard.
 * - Receivables and payables by age and cash per account are breakdowns, as
 *   of today, so the range does not change them.
 *
 * Those six are only the default: every chart is one entry of the user's list
 * (`useDashboardCharts`). "Add chart" and a chart's "Edit" open the chart
 * builder; "Edit" on the heading turns the grid into a draft whose charts can
 * be dragged to a new place or taken off, then saved or cancelled.
 */

import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { LayoutGrid, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useDashboardCharts } from '@/hooks/queries/use-weldbooks-dashboard-charts';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { CustomChartCard, SortableChartCard } from './custom-chart-card';
import type { DashboardChart } from './custom-charts';
import { dashboardTrend, type Compare } from './dashboard-series';
import { FilterPill } from './filter-pill';

type Range = '3' | '6' | '12';

export const CHART_BUILDER_PATH = '/weldbooks/dashboard/builder';

const GRID = 'grid gap-x-12 gap-y-14 md:grid-cols-2 lg:grid-cols-3';

export function OverviewSection({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const tb = t.accounting.dashboard.builder;
  const router = useRouter();
  const [range, setRange] = useState<Range>('12');
  const [compareChoice, setCompareChoice] = useState<Compare | 'off'>('previousPeriod');
  const compare = compareChoice === 'off' ? null : compareChoice;
  const { months, sample } = useMemo(() => dashboardTrend(dashboard), [dashboard]);
  const { charts, removeChart, setCharts, isSaving } = useDashboardCharts();
  const filter = useMemo(() => ({ size: Number(range), compare }), [range, compare]);
  /** The layout being edited; `null` while the overview is not being edited. */
  const [draft, setDraft] = useState<DashboardChart[] | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const rangeOptions = [
    { value: '3' as const, label: tc.last3Months },
    { value: '6' as const, label: tc.last6Months },
    { value: '12' as const, label: tc.last12Months },
  ];
  const compareOptions = [
    { value: 'previousPeriod' as const, label: tc.previousPeriod, short: tc.vsPreviousPeriod },
    { value: 'previousYear' as const, label: tc.previousYear, short: tc.vsPreviousYear },
    { value: 'off' as const, label: tc.compareOff, short: tc.noComparisonShort },
  ];
  const body = { dashboard, months, sample, filter };
  const addChart = () => router.push(CHART_BUILDER_PATH);

  const remove = (id: string) => {
    const previous = charts;
    removeChart(id).then(
      () => toast.success(tb.chartRemoved, { action: { label: tb.undo, onClick: () => void setCharts(previous) } }),
      () => toast.error(tb.saveFailed),
    );
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setDraft((current) => {
      if (!current) return current;
      const from = current.findIndex((c) => c.id === active.id);
      const to = current.findIndex((c) => c.id === over.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
  };

  const saveLayout = async () => {
    if (!draft) return;
    try {
      await setCharts(draft);
      setDraft(null);
      toast.success(tb.layoutSaved);
    } catch {
      toast.error(tb.saveFailed);
    }
  };

  return (
    <section className="space-y-14 pt-10">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b pb-4">
        <h2 className="text-2xl font-medium leading-6">{tc.overview}</h2>
        {draft ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
              {tb.cancel}
            </Button>
            <Button size="sm" onClick={saveLayout} disabled={isSaving}>
              {tb.save}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <FilterPill label={tc.dateRange} value={range} options={rangeOptions} onChange={setRange} />
            <FilterPill label={tc.compare} value={compareChoice} options={compareOptions} onChange={setCompareChoice} />
            <Button variant="outline" size="sm" onClick={addChart}>
              <Plus className="size-3.5" aria-hidden />
              {tb.addChart}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDraft(charts)}>
              <LayoutGrid className="size-3.5" aria-hidden />
              {tb.editLayout}
            </Button>
          </div>
        )}
      </div>

      {draft && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={draft.map((c) => c.id)} strategy={rectSortingStrategy}>
            {draft.length === 0 ? (
              <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">{tb.editEmpty}</p>
            ) : (
              <div className={GRID}>
                {draft.map((chart) => (
                  <SortableChartCard
                    key={chart.id}
                    chart={chart}
                    onRemove={() => setDraft((current) => current?.filter((c) => c.id !== chart.id) ?? current)}
                    {...body}
                  />
                ))}
              </div>
            )}
          </SortableContext>
        </DndContext>
      )}

      {!draft && charts.length === 0 && (
        <div className="flex flex-col items-center py-6 text-center">
          <ChartsIllustration />
          <h3 className="mb-1.5 text-[15px] font-semibold">{tb.emptyTitle}</h3>
          <p className="mb-5 text-sm text-muted-foreground">{tb.emptyDescription}</p>
          <Button size="sm" onClick={addChart}>
            <Plus className="size-4" aria-hidden />
            {tb.addChart}
          </Button>
        </div>
      )}

      {!draft && charts.length > 0 && (
        <div className={GRID}>
          {charts.map((chart) => (
            <CustomChartCard
              key={chart.id}
              chart={chart}
              onEdit={() => router.push(`${CHART_BUILDER_PATH}?chartId=${encodeURIComponent(chart.id)}`)}
              onRemove={() => remove(chart.id)}
              {...body}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** A small bar chart on the house dashed grid. */
function ChartsIllustration() {
  const bars = [34, 52, 42, 66, 58];
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="14" y="18" width="92" height="84" rx="8" className="fill-white stroke-gray-200 dark:fill-white/[0.03] dark:stroke-white/15" strokeWidth="1" />
        <rect x="24" y="28" width="34" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
        <path d="M24 90H96" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        {bars.map((height, i) => (
          <rect
            key={height}
            x={28 + i * 14}
            y={90 - height * 0.75}
            width="8"
            height={height * 0.75}
            rx="2"
            className={i === bars.length - 2 ? 'fill-primary/60' : 'fill-gray-200 dark:fill-white/15'}
          />
        ))}
      </svg>
    </EmptyStateIllustration>
  );
}
