/**
 * One chart of "Your overview". `CustomChartBody` draws a chart's settings
 * (it is also the chart builder's preview); around it:
 *
 * - `CustomChartCard`: the bare card, its title linking to the report behind
 *   the figure, with a menu on the title row to edit (in the chart builder)
 *   or remove it.
 * - `SortableChartCard`: the same chart while the overview is being edited,
 *   outlined, dragged anywhere on the card (or moved with the keyboard), with
 *   a button to take it off. Its chart ignores the pointer, so no tooltip gets
 *   in the way of a drag.
 *
 * Every card re-renders on each pointer move of a drag (dnd-kit moves them by
 * transform), so the chart body is memoised: its props do not change during a
 * drag, and redrawing six Recharts charts per move made dragging stutter.
 */

import { memo, type CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { BreakdownBody, MetricChartBody } from './chart-bodies';
import { SOURCE_LINKS, isTrendSource, type ChartSource, type DashboardChart } from './custom-charts';
import type { Compare, TrendMonth } from './dashboard-series';
import { OverviewCard } from './overview-card';

/** The overview's own date range (months) and comparison, which a chart set to "dashboard" follows. */
export type OverviewFilter = { size: number; compare: Compare | null };

type BodyProps = { dashboard: Dashboard; months: TrendMonth[]; sample: boolean; filter: OverviewFilter };

export function useSourceLabels(): Record<ChartSource, string> {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  return {
    revenue: tc.revenue,
    expenses: tc.expenses,
    profit: tc.netProfit,
    receivables: tc.receivablesByAge,
    payables: tc.payablesByAge,
    cash: tc.cash,
  };
}

/** A chart's title and explanation, falling back to its figure's own name and explanation, and where the title links to. */
export function useChartHeading(chart: DashboardChart) {
  const { t } = useI18n();
  const sourceLabels = useSourceLabels();
  const sourceInfo: Record<ChartSource, string> = t.accounting.dashboard.charts.info;
  return {
    title: chart.title || sourceLabels[chart.source],
    info: chart.description || sourceInfo[chart.source],
    to: SOURCE_LINKS[chart.source],
  };
}

export const CustomChartBody = memo(function CustomChartBody({
  chart,
  dashboard,
  months,
  sample,
  filter,
}: Readonly<BodyProps & { chart: DashboardChart }>) {
  if (!isTrendSource(chart.source)) return <BreakdownBody source={chart.source} dashboard={dashboard} />;
  const size = chart.range === 'dashboard' ? filter.size : Number(chart.range);
  let compare: Compare | null = filter.compare;
  if (chart.compare === 'off') compare = null;
  else if (chart.compare !== 'dashboard') compare = chart.compare;
  return (
    <MetricChartBody
      metric={chart.source}
      months={months}
      sample={sample}
      size={size}
      compare={compare}
      shape={chart.type === 'breakdown' ? 'line' : chart.type}
      color={chart.color}
      label={chart.title}
    />
  );
});

export function CustomChartCard({
  chart,
  onEdit,
  onRemove,
  ...body
}: Readonly<BodyProps & { chart: DashboardChart; onEdit: () => void; onRemove: () => void }>) {
  const { t } = useI18n();
  const tb = t.accounting.dashboard.builder;
  const heading = useChartHeading(chart);

  return (
    <OverviewCard
      {...heading}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label={tb.chartActions}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              {tb.editChart}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              {tb.removeChart}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <CustomChartBody chart={chart} {...body} />
    </OverviewCard>
  );
}

export function SortableChartCard({
  chart,
  onRemove,
  ...body
}: Readonly<BodyProps & { chart: DashboardChart; onRemove: () => void }>) {
  const { t } = useI18n();
  const tb = t.accounting.dashboard.builder;
  const { title } = useChartHeading(chart);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chart.id });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      aria-label={tb.moveChart.replace('{name}', title)}
      className={cn(
        '-m-3 flex min-w-0 cursor-grab touch-none flex-col rounded-lg border border-dashed bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
        isDragging && 'relative z-10 border-solid shadow-lg',
      )}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{title}</span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          aria-label={tb.removeChartNamed.replace('{name}', title)}
          // The card is the drag handle: a press on its button must not start a drag.
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={onRemove}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="pointer-events-none mt-3 flex flex-1 select-none flex-col">
        <CustomChartBody chart={chart} {...body} />
      </div>
    </div>
  );
}
