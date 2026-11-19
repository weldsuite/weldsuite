/**
 * Weekly demand for one item: the last 52 weeks sold as bars, the engine's
 * forecast for the next 13 weeks as a dashed line.
 */

import { useMemo } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import type { PlanDemand } from '@weldsuite/app-api-client/schemas/replenishment';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { getLocale, getTranslations } from '@/lib/i18n';

export interface DemandChartPoint {
  weekStart: string;
  history: number | null;
  forecast: number | null;
}

/**
 * History and forecast as one series by week. The first forecast week also
 * carries the last history value, so the dashed line starts where the bars end.
 */
export function demandChartData(demand: PlanDemand): DemandChartPoint[] {
  const points: DemandChartPoint[] = demand.history.map((p) => ({ weekStart: p.weekStart, history: p.quantity, forecast: null }));
  const last = points.at(-1);
  if (last && demand.forecast.length > 0) last.forecast = last.history;
  for (const p of demand.forecast) points.push({ weekStart: p.weekStart, history: null, forecast: Math.round(p.quantity * 10) / 10 });
  return points;
}

export function DemandChart({ demand }: Readonly<{ demand: PlanDemand }>) {
  const t = getTranslations('weldstashReplenishment').panel;
  const locale = getLocale();
  const data = useMemo(() => demandChartData(demand), [demand]);
  const config: ChartConfig = {
    history: { label: t.chartHistory, color: 'var(--chart-1)' },
    forecast: { label: t.chartForecast, color: 'var(--chart-2)' },
  };
  const month = new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' });
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const parse = (weekStart: string) => new Date(`${weekStart}T00:00:00Z`);

  return (
    <div className="space-y-2">
      <ChartContainer config={config} className="h-52 w-full">
        <ComposedChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="weekStart"
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tickFormatter={(value: string) => month.format(parse(value))}
          />
          <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
          <ChartTooltip
            content={<ChartTooltipContent labelFormatter={(_, payload) => {
              const week = payload?.[0]?.payload?.weekStart as string | undefined;
              return week ? t.chartWeekOf.replace('{date}', day.format(parse(week))) : '';
            }} />}
          />
          <Bar dataKey="history" fill="var(--color-history)" radius={[2, 2, 0, 0]} />
          <Line dataKey="forecast" type="monotone" stroke="var(--color-forecast)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
        </ComposedChart>
      </ChartContainer>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: 'var(--chart-1)' }} />
          {t.chartHistory}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: 'var(--chart-2)' }} />
          {t.chartForecast}
        </span>
      </div>
    </div>
  );
}
