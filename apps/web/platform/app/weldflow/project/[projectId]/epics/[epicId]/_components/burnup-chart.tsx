/**
 * An epic's burnup: the points completed over time against the scope (the
 * points of the items that existed by then), from the items' creation and
 * completion dates. A scope line that climbs is scope growth, which a burndown
 * would hide.
 */

import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { burnupSeries, type BacklogItem } from '@/app/weldflow/lib/backlog';

const SCOPE_COLOR = 'var(--muted-foreground)';
const DONE_COLOR = '#7c3aed';

export function BurnupChart({ items }: Readonly<{ items: readonly BacklogItem[] }>) {
  const { t, language, format } = useI18n();
  const copy = t.flowAgileBacklog.epicPage.burnup;
  const now = useMemo(() => Date.now(), []);
  const series = useMemo(() => burnupSeries(items, now), [items, now]);
  const first = series[0];
  const last = series.at(-1);
  const locale = intlLocaleOf(language);
  const day = (value: number) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(value));
  const config = {
    scope: { label: copy.scope, color: SCOPE_COLOR },
    done: { label: copy.done, color: DONE_COLOR },
  } satisfies ChartConfig;

  if (!first || !last || last.scope === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{copy.empty}</p>;
  }

  const grew = last.scope - first.scope;
  return (
    <figure className="m-0 space-y-3">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{copy.title}</span>
        <span className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: DONE_COLOR }} />
            {copy.done}
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="w-3 border-t-2 border-dashed" style={{ borderColor: SCOPE_COLOR }} />
            {copy.scope}
          </span>
        </span>
      </figcaption>
      <div role="img" aria-label={format(copy.label, { done: last.done ?? 0, scope: last.scope })}>
        <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
          <LineChart data={series} margin={{ top: 8, left: 0, right: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              type="number"
              dataKey="t"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={day}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              className="text-xs"
            />
            <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} domain={[0, (max: number) => Math.max(max, 1)]} className="text-xs" />
            <ChartTooltip
              cursor={{ stroke: 'var(--border)' }}
              content={<ChartTooltipContent labelFormatter={(_, payload) => day(Number((payload?.[0]?.payload as { t?: number } | undefined)?.t))} />}
            />
            <Line dataKey="scope" type="stepAfter" stroke={SCOPE_COLOR} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
            <Line dataKey="done" type="monotone" stroke={DONE_COLOR} strokeWidth={2.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartContainer>
      </div>
      <p className="text-xs text-muted-foreground">{grew > 0 ? format(copy.scopeGrew, { points: grew }) : copy.scopeHeld}</p>
    </figure>
  );
}
