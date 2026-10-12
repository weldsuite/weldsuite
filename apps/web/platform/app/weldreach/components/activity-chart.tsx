/**
 * Emails sent and replies received per day over the last 14 days.
 *
 * Two small bar charts side by side instead of one chart with two series: sent
 * volume dwarfs replies, so a shared axis would flatten the replies and a
 * second axis would mislead. Each keeps its own scale, a plain title with its
 * total, and the same x axis.
 */

import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@weldsuite/ui/components/chart';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachOverview } from '@weldsuite/app-api-client/schemas/reach';
import { useReachFormat } from '@/lib/reach/format';

type DailyPoint = ReachOverview['daily'][number];

function SeriesChart({
  data,
  dataKey,
  title,
  color,
}: Readonly<{ data: DailyPoint[]; dataKey: 'sent' | 'replies'; title: string; color: string }>) {
  const format = useReachFormat();
  const total = data.reduce((sum, point) => sum + point[dataKey], 0);

  const config = useMemo(() => ({ [dataKey]: { label: title, color } }) satisfies ChartConfig, [dataKey, title, color]);
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(format.locale, { month: 'short', day: 'numeric' }), [format.locale]);
  // ISO dates (YYYY-MM-DD) are calendar days: read them as local days so no time zone shifts them.
  const toDay = (value: string) => new Date(`${value}T00:00:00`);

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-sm font-semibold tabular-nums">{format.number(total)}</span>
      </div>
      <ChartContainer config={config} className="aspect-auto h-[180px] w-full">
        <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={(value: string) => dayFormat.format(toDay(value))}
          />
          <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                nameKey={dataKey}
                labelFormatter={(value: string) => dayFormat.format(toDay(String(value)))}
              />
            }
          />
          <Bar dataKey={dataKey} fill={`var(--color-${dataKey})`} radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ChartContainer>
    </div>
  );
}

export function ActivityChart({ daily }: Readonly<{ daily: ReachOverview['daily'] }>) {
  const t = useTranslations();
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <SeriesChart data={daily} dataKey="sent" title={t('reach.overview.chart.sent')} color="var(--chart-1)" />
      <SeriesChart data={daily} dataKey="replies" title={t('reach.overview.chart.replies')} color="var(--chart-3)" />
    </div>
  );
}
