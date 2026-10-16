/**
 * Open receivables or payables by how far past due they are: the aged report's
 * buckets as bars, not-yet-due in the chart colour and overdue in a red that
 * deepens with age. An API without `aging` still has the outstanding and
 * overdue totals, so the chart then shows those two bars.
 */

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import type { Dashboard, DashboardAgingBucket } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useChartFormat } from './use-chart-format';
import { MoneyTooltipRow } from './money-tooltip-row';

type Side = 'receivables' | 'payables';
type Point = { key: string; axisLabel: string; label: string; total: number; count?: number; overdueLevel: number };

const BUCKETS: DashboardAgingBucket[] = ['current', '1-30', '31-60', '61-90', '90+'];
/** Opacity of the destructive colour per overdue level (0 = not yet due). */
const OVERDUE_OPACITY = [1, 0.45, 0.65, 0.85, 1];

export function AgingChart({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const format = useChartFormat();
  const [side, setSide] = useState<Side>('receivables');

  const summary = dashboard[side];
  const points = useMemo<Point[]>(() => {
    // The axis shows the bare range so five buckets fit a narrow card; the tooltip says "days".
    const ranges: Record<DashboardAgingBucket, string> = {
      current: tc.aging.current,
      '1-30': '1–30',
      '31-60': '31–60',
      '61-90': '61–90',
      '90+': '90+',
    };
    if (summary?.aging) {
      return BUCKETS.map((bucket, index) => ({
        key: bucket,
        axisLabel: ranges[bucket],
        label: bucket === 'current' ? ranges[bucket] : tc.aging.days.replace('{range}', ranges[bucket]),
        total: Number(summary.aging?.[bucket].total ?? 0),
        count: summary.aging?.[bucket].count,
        overdueLevel: index,
      }));
    }
    const overdue = Number(summary?.overdue ?? 0);
    return [
      { key: 'current', axisLabel: tc.aging.current, label: tc.aging.current, total: Number(summary?.outstanding ?? 0) - overdue, overdueLevel: 0 },
      { key: 'overdue', axisLabel: tc.aging.overdue, label: tc.aging.overdue, total: overdue, overdueLevel: 4 },
    ];
  }, [summary, tc.aging]);

  const config = useMemo(() => ({ total: { label: tc.aging.balance, color: 'var(--chart-1)' } }) satisfies ChartConfig, [tc.aging.balance]);
  const fillOf = (level: number) => (level === 0 ? 'var(--chart-1)' : 'var(--destructive)');
  const overdueCount = summary?.overdueCount ?? 0;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{tc.aging.title}</CardTitle>
          <ToggleGroup type="single" variant="outline" size="sm" value={side} onValueChange={(v) => v && setSide(v as Side)}>
            <ToggleGroupItem value="receivables" className="px-2.5 text-xs">{tc.aging.receivables}</ToggleGroupItem>
            <ToggleGroupItem value="payables" className="px-2.5 text-xs">{tc.aging.payables}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <CardDescription>
          {overdueCount > 0 ? tc.aging.overdueCount.replace('{count}', String(overdueCount)) : tc.aging.nothingOverdue}
        </CardDescription>
        <p className="text-2xl font-semibold tabular-nums">{format.formatMoney(Number(summary?.outstanding ?? 0))}</p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
          <BarChart accessibilityLayer data={points} margin={{ left: 0, right: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="axisLabel" tickLine={false} axisLine={false} tickMargin={8} interval={0} fontSize={11} />
            <YAxis width={52} tickLine={false} axisLine={false} tickFormatter={format.compactMoney} />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  hideIndicator
                  labelFormatter={(_, payload) => {
                    const point = payload?.[0]?.payload as Point | undefined;
                    if (!point) return '';
                    return point.count === undefined ? point.label : `${point.label} · ${tc.aging.documents.replace('{count}', String(point.count))}`;
                  }}
                  formatter={(value, _name, item) => {
                    const level = (item.payload as Point).overdueLevel;
                    return <MoneyTooltipRow label={tc.aging.balance} color={fillOf(level)} value={format.formatMoney(Number(value))} />;
                  }}
                />
              }
            />
            <Bar dataKey="total" radius={4} maxBarSize={40}>
              {points.map((p) => (
                <Cell key={p.key} fill={fillOf(p.overdueLevel)} fillOpacity={OVERDUE_OPACITY[p.overdueLevel]} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
