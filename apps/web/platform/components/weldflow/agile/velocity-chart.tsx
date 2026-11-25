import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { FOLLOWING_TOOLTIP_PROPS, FollowingTooltip } from '@weldsuite/ui/components/following-tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import type { VelocityBar } from '@/app/weldflow/lib/sprint-metrics';

const COMMITTED_COLOR = 'var(--muted-foreground)';
const COMPLETED_COLOR = 'var(--chart-1)';
const AXIS_LABEL = 'fill-muted-foreground text-xs tabular-nums';

/**
 * Velocity: per completed sprint the story points committed next to the ones
 * completed, with the average as a dashed line. The figures are also there as
 * a table for screen readers.
 */
export function VelocityChart({
  bars,
  average,
  label,
  className,
}: Readonly<{ bars: readonly VelocityBar[]; average: number | null; label: string; className?: string }>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileSprints.analytics;
  const config = {
    committed: { label: copy.committed, color: COMMITTED_COLOR },
    completed: { label: copy.completed, color: COMPLETED_COLOR },
  } satisfies ChartConfig;
  const points = (value: number) => plural(value, t.flowAgile.points);

  return (
    <figure className={cn('min-w-0 space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2.5 rounded-[2px] opacity-40" style={{ backgroundColor: COMMITTED_COLOR }} />
          {copy.committed}
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2.5 rounded-[2px]" style={{ backgroundColor: COMPLETED_COLOR }} />
          {copy.completed}
        </span>
        {average === null ? null : (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="w-3 border-t-2 border-dashed border-muted-foreground" />
            {format(copy.average, { count: average })}
          </span>
        )}
      </div>
      <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
        <BarChart accessibilityLayer data={bars as VelocityBar[]} margin={{ top: 8, left: 0, right: 0, bottom: 0 }} barGap={4}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <YAxis orientation="right" tickLine={false} axisLine={false} width={32} tick={{ className: AXIS_LABEL }} allowDecimals={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} tick={{ className: AXIS_LABEL }} interval="preserveStartEnd" />
          <ChartTooltip
            {...FOLLOWING_TOOLTIP_PROPS}
            cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
            content={(props) => (
              <FollowingTooltip active={props.active} coordinate={props.coordinate}>
                <ChartTooltipContent
                  active={props.active}
                  payload={props.payload}
                  label={props.label}
                  formatter={(value, name) => (
                    <ChartTooltipRow
                      swatch="square"
                      label={name === 'committed' ? copy.committed : copy.completed}
                      color={name === 'committed' ? COMMITTED_COLOR : COMPLETED_COLOR}
                      value={points(Number(value))}
                    />
                  )}
                />
              </FollowingTooltip>
            )}
          />
          {average === null ? null : <ReferenceLine y={average} stroke="var(--muted-foreground)" strokeDasharray="4 4" />}
          <Bar dataKey="committed" fill={COMMITTED_COLOR} fillOpacity={0.35} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          <Bar dataKey="completed" fill={COMPLETED_COLOR} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      <figcaption className="sr-only">{label}</figcaption>
      <table className="sr-only">
        <caption>{copy.velocityTable}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.columns.sprint}</th>
            <th scope="col">{copy.committed}</th>
            <th scope="col">{copy.completed}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.id}>
              <th scope="row">{bar.name}</th>
              <td>{bar.committed}</td>
              <td>{bar.completed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
