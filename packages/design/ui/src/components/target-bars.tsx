/**
 * Amounts against their targets (budgets, goals, plan limits), as dub.co
 * draws usage against a limit: per row the label with the amount and its
 * target, then a 12px rounded track filled to the amount's share of the
 * target. Over the target the fill runs full and turns red, and so does the
 * amount.
 *
 * Each bar is an ARIA meter. The component holds no text of its own: amounts
 * come in formatted, and `targetLabel` words the target ("of €110,000").
 */

import { cn } from '@weldsuite/ui/lib/utils';

export interface TargetBarsItem {
  key: string;
  label: string;
  value: number;
  target: number;
  /** The amount as shown, such as "€92,400". */
  display: string;
  /** The target as shown, such as "€110,000". */
  targetDisplay: string;
}

export interface TargetBarsProps {
  items: TargetBarsItem[];
  /** The fill's colour under the target; `--chart-1` by default. */
  color?: string;
  /** The text after the amount, from the formatted target: "of €110,000". "/ €110,000" by default. */
  targetLabel?: (targetDisplay: string) => string;
  className?: string;
}

const defaultTargetLabel = (target: string) => `/ ${target}`;

export function TargetBars({ items, color = 'var(--chart-1)', targetLabel = defaultTargetLabel, className }: Readonly<TargetBarsProps>) {
  return (
    <ul className={cn('grid gap-4', className)}>
      {items.map((item) => {
        const over = item.value > item.target;
        let share = 0;
        if (item.target > 0) share = Math.min(Math.max(item.value, 0) / item.target, 1);
        else if (item.value > 0) share = 1;
        const target = targetLabel(item.targetDisplay);
        return (
          <li key={item.key} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{item.label}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                <span className={over ? 'text-destructive' : 'text-foreground'}>{item.display}</span> {target}
              </span>
            </div>
            <div
              role="meter"
              aria-label={item.label}
              aria-valuemin={0}
              aria-valuemax={item.target}
              aria-valuenow={item.value}
              aria-valuetext={`${item.display} ${target}`}
              className="h-3 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn('h-full transition-[width] duration-500 motion-reduce:transition-none', over && 'bg-destructive')}
                style={{ width: `${share * 100}%`, backgroundColor: over ? undefined : color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
