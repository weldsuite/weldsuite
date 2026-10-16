/**
 * Net profit per month over the last 12 months: a bar chart with loss months
 * in the destructive colour, and this year's profit to date as the headline figure.
 */

import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useChartFormat } from './use-chart-format';
import { MoneyTooltipRow } from './money-tooltip-row';

const PROFIT = 'var(--chart-1)';
const LOSS = 'var(--destructive)';

export function ProfitChart({ trend, profitYear }: Readonly<{ trend: NonNullable<Dashboard['monthlyTrend']>; profitYear?: string }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const format = useChartFormat();

  const points = useMemo(() => trend.slice(-12).map((m) => ({ month: m.month, profit: Number(m.profit) })), [trend]);
  const config = useMemo(() => ({ profit: { label: tc.netProfit, color: PROFIT } }) satisfies ChartConfig, [tc.netProfit]);
  const year = Number(profitYear ?? 0);

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">{tc.netProfit}</CardTitle>
        <CardDescription>{tc.byMonth}</CardDescription>
        <p className="flex items-baseline gap-2">
          <span className={`text-2xl font-semibold tabular-nums ${year < 0 ? 'text-destructive' : ''}`}>{format.formatMoney(year)}</span>
          <span className="text-xs text-muted-foreground">{tc.thisYear}</span>
        </p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
          <BarChart accessibilityLayer data={points} margin={{ left: 0, right: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} minTickGap={8} tickFormatter={format.monthShort} />
            <YAxis width={52} tickLine={false} axisLine={false} tickFormatter={format.compactMoney} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  hideIndicator
                  labelFormatter={(_, payload) => format.monthLong(String(payload?.[0]?.payload?.month ?? ''))}
                  formatter={(value) => (
                    <MoneyTooltipRow
                      label={tc.netProfit}
                      color={Number(value) < 0 ? LOSS : PROFIT}
                      value={format.formatMoney(Number(value))}
                    />
                  )}
                />
              }
            />
            <Bar dataKey="profit" radius={4} maxBarSize={24}>
              {points.map((p) => (
                <Cell key={p.month} fill={p.profit < 0 ? LOSS : PROFIT} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
