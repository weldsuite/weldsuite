/**
 * A conversion funnel, as on dub.co's analytics: a column per step, split by
 * thin dividers, with a smooth band through them whose height is each step's
 * count, two fainter layers around it, and a pill in the middle of each column
 * with the step's share of the first one. Each column names its step and count
 * at the top; under the pointer it tints and shows a card with the conversion
 * from the step before.
 *
 * The drawing is decoration for sighted users: a hidden list reads out every
 * step, its count and its conversion. The component holds no text of its own:
 * labels and counts come in with the steps, the rest through the formatters.
 */

import { useState } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { useElementSize } from '@weldsuite/ui/hooks/use-element-size';
import { cn } from '@weldsuite/ui/lib/utils';

export interface FunnelStep {
  key: string;
  label: string;
  value: number;
  /** The count as shown, such as "12,400". */
  display: string;
  /** The step's colour; the chart colours in turn by default. */
  color?: string;
}

export interface FunnelChartProps {
  steps: FunnelStep[];
  /** A 0-1 share as text; a whole percentage (one decimal under 10%) by default. */
  formatPercent?: (share: number) => string;
  /** The card's line for a step after the first, from its share of the step before: "25% of visitors". */
  conversionLabel?: (share: number, previous: FunnelStep) => string;
  /** Height and other sizing; `h-60` by default. */
  className?: string;
}

export const FUNNEL_COLORS = ['var(--chart-1)', '#8d7ffa', '#00a2b8', '#10b981', '#ed6704', '#df1b41'];
/** The band and its two fainter layers: opacity, and how far each reaches past the band. */
const LAYERS: Array<[opacity: number, pad: number]> = [
  [0.15, 16],
  [0.3, 8],
  [1, 0],
];
/** Room above and below the widest band, past its outer layer, for the step names. */
const EDGE = 52;

const defaultPercent = (share: number) => `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`;

/**
 * One column's band, symmetric around `mid`: flat at this step's half height
 * `from` for the first 30%, an S-curve down to the next step's `to` by 70%,
 * then flat.
 */
function bandPath(x: number, width: number, mid: number, from: number, to: number): string {
  const at = (f: number) => x + width * f;
  return [
    `M${x},${mid - from}`,
    `L${at(0.3)},${mid - from}`,
    `C${at(0.5)},${mid - from} ${at(0.5)},${mid - to} ${at(0.7)},${mid - to}`,
    `L${at(1)},${mid - to}`,
    `L${at(1)},${mid + to}`,
    `L${at(0.7)},${mid + to}`,
    `C${at(0.5)},${mid + to} ${at(0.5)},${mid + from} ${at(0.3)},${mid + from}`,
    `L${x},${mid + from}`,
    'Z',
  ].join(' ');
}

export function FunnelChart({ steps, formatPercent = defaultPercent, conversionLabel, className }: Readonly<FunnelChartProps>) {
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);
  const first = steps[0]?.value ?? 0;
  const max = Math.max(0, ...steps.map((step) => step.value));
  const columnWidth = steps.length > 0 ? width / steps.length : 0;
  const mid = height / 2;
  const reach = Math.max(mid - EDGE - LAYERS[0][1], 0);
  const half = (value: number) => Math.max(max > 0 ? (Math.max(value, 0) / max) * reach : 0, 1.5);
  const colorOf = (step: FunnelStep, index: number) => step.color ?? FUNNEL_COLORS[index % FUNNEL_COLORS.length];
  const conversion = (index: number) => {
    const previous = steps[index - 1];
    if (!previous) return formatPercent(1);
    const share = previous.value > 0 ? steps[index].value / previous.value : 0;
    return conversionLabel ? conversionLabel(share, previous) : formatPercent(share);
  };

  return (
    <div ref={ref} className={cn('relative h-60 w-full', className)}>
      <ol className="sr-only">
        {steps.map((step, index) => (
          <li key={step.key}>
            {step.label}: {step.display}
            {index > 0 && ` (${conversion(index)})`}
          </li>
        ))}
      </ol>
      {width > 0 && height > 0 && (
        <div aria-hidden className="absolute inset-0">
          <svg width={width} height={height} className="absolute inset-0">
            {steps.map((step, index) => {
              const next = steps[index + 1] ?? step;
              return LAYERS.map(([opacity, pad]) => (
                <path
                  key={`${step.key}-${pad}`}
                  d={bandPath(index * columnWidth, columnWidth, mid, half(step.value) + pad, half(next.value) + pad)}
                  style={{ fill: colorOf(step, index), fillOpacity: opacity }}
                />
              ));
            })}
          </svg>
          <div className="absolute inset-0 flex">
            {steps.map((step, index) => {
              const color = colorOf(step, index);
              return (
                <div
                  key={step.key}
                  className={cn(
                    'relative min-w-0 flex-1 transition-colors',
                    index > 0 && 'border-l',
                    hovered === step.key && 'bg-[color-mix(in_oklab,var(--chart-1)_5%,transparent)]',
                  )}
                  onPointerEnter={() => setHovered(step.key)}
                  onPointerLeave={() => setHovered(null)}
                >
                  <div className="px-3 pt-3">
                    <p className="truncate text-xs text-muted-foreground">{step.label}</p>
                    <p className="text-sm tabular-nums">{step.display}</p>
                  </div>
                  <span
                    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background px-3 py-1 text-sm font-medium tabular-nums"
                    style={{ color }}
                  >
                    {formatPercent(first > 0 ? Math.max(step.value, 0) / first : 0)}
                  </span>
                  {hovered === step.key && (
                    <ChartHoverCard
                      title={step.label}
                      // Centred under the pill; at the ends, kept inside the chart.
                      className={cn(
                        'pointer-events-none absolute top-[calc(50%+1.5rem)] z-10 w-max',
                        index === 0 && 'left-2',
                        index === steps.length - 1 && index > 0 && 'right-2',
                        index > 0 && index < steps.length - 1 && 'left-1/2 -translate-x-1/2',
                      )}
                    >
                      <ChartTooltipRow swatch="square" color={color} label={conversion(index)} value={step.display} />
                    </ChartHoverCard>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
