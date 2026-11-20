/**
 * One figure against its limit on a half circle: a grey track, filled from
 * the left to the figure's share of the limit, red once over it, with an
 * optional mark at a target. The share sits large in the middle with a line
 * under it (such as "€72,400 of €100,000"), and the ends can be named.
 *
 * It is an ARIA meter. The component holds no text of its own: the line,
 * the end names and the share's format come in as props.
 */

import { cn } from '@weldsuite/ui/lib/utils';

export interface GaugeProps {
  value: number;
  /** A full gauge. */
  max: number;
  /** Draws a mark across the track here, such as a budget's warning point. */
  target?: number;
  /** Names the gauge for assistive tech. */
  label: string;
  /** The line under the share, such as "€72,400 of €100,000". */
  detail?: string;
  /** A 0-1 share as text (can be over 1); a whole percentage by default. */
  formatShare?: (share: number) => string;
  /** The words under the left and right ends, such as "€0" and "€100,000". */
  minLabel?: string;
  maxLabel?: string;
  /** The fill's colour under the limit; `--chart-1` by default. */
  color?: string;
  className?: string;
}

const CX = 100;
const CY = 100;
const RADIUS = 84;
const STROKE = 16;
const defaultShare = (share: number) => `${Math.round(share * 100)}%`;

/** The point on the half circle at a 0-1 share, from the left end over the top to the right. */
const at = (share: number, radius = RADIUS) => {
  const angle = Math.PI + Math.PI * share;
  return [CX + radius * Math.cos(angle), CY + radius * Math.sin(angle)] as const;
};

export function Gauge({
  value,
  max,
  target,
  label,
  detail,
  formatShare = defaultShare,
  minLabel,
  maxLabel,
  color = 'var(--chart-1)',
  className,
}: Readonly<GaugeProps>) {
  let share = 0;
  if (max > 0) share = Math.max(value, 0) / max;
  else if (value > 0) share = 1;
  const over = share > 1;
  const filled = Math.min(share, 1);
  const [sx, sy] = at(0);
  const [ex, ey] = at(filled);
  const targetShare = target === undefined || max <= 0 ? null : Math.min(Math.max(target / max, 0), 1);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={detail ? `${formatShare(share)}, ${detail}` : formatShare(share)}
      className={cn('relative w-full max-w-72', className)}
    >
      <svg aria-hidden viewBox="0 0 200 108" className="w-full overflow-visible">
        <path d={`M${sx},${sy} A${RADIUS},${RADIUS} 0 0 1 ${at(1)[0]},${at(1)[1]}`} fill="none" strokeWidth={STROKE} strokeLinecap="round" style={{ stroke: 'var(--muted)' }} />
        {filled > 0 && (
          <path
            d={`M${sx},${sy} A${RADIUS},${RADIUS} 0 0 1 ${ex},${ey}`}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            style={{ stroke: over ? 'var(--destructive)' : color }}
          />
        )}
        {targetShare !== null && (
          <line
            x1={at(targetShare, RADIUS - STROKE / 2 - 4)[0]}
            y1={at(targetShare, RADIUS - STROKE / 2 - 4)[1]}
            x2={at(targetShare, RADIUS + STROKE / 2 + 4)[0]}
            y2={at(targetShare, RADIUS + STROKE / 2 + 4)[1]}
            strokeWidth={2}
            style={{ stroke: 'var(--foreground)' }}
          />
        )}
      </svg>
      <div aria-hidden className="absolute inset-x-0 bottom-1 flex flex-col items-center text-center">
        <span className={cn('text-3xl font-medium tabular-nums', over && 'text-destructive')}>{formatShare(share)}</span>
        {detail && <span className="text-sm text-muted-foreground tabular-nums">{detail}</span>}
      </div>
      {(minLabel || maxLabel) && (
        <div aria-hidden className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
}
