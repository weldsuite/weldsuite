/**
 * A ranked list, as on dub.co's analytics ("Top links"): a row per item,
 * biggest first, whose bar is a light tint behind the label, as wide as the
 * item's share of the biggest one, with the value on the right. The bars run
 * edge to edge, in line with the column headings above them. Under the
 * pointer (or keyboard focus) the row gets a faint tint and the item's share
 * of the total shows before its value.
 *
 * Rows can be buttons (`onSelect`), and a long list can stop at `limit` with
 * a "show all" button under it (`onShowAll`). The component holds no text of
 * its own: labels and formatted values come in with the items.
 */

import type { CSSProperties, ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';

export interface RankedBarsItem {
  key: string;
  label: string;
  /** Sizes the bar and the share. */
  value: number;
  /** The value as shown, such as "€21,400" or "1,284". */
  display: string;
  /** A favicon, flag, avatar or icon, about 20px. */
  icon?: ReactNode;
}

export interface RankedBarsProps {
  items: RankedBarsItem[];
  /** The bars' colour; `--chart-1` by default. */
  color?: string;
  /** A 0-1 share as text; a whole percentage by default. */
  formatShare?: (share: number) => string;
  /** Shows only the first rows; with `onShowAll`, a button under them shows the rest. */
  limit?: number;
  onShowAll?: () => void;
  showAllLabel?: string;
  /** Makes each row a button. */
  onSelect?: (item: RankedBarsItem) => void;
  /** Names the list for assistive tech. */
  label?: string;
  className?: string;
}

const defaultShare = (share: number) => `${Math.round(share * 100)}%`;

export function RankedBars({
  items,
  color = 'var(--chart-1)',
  formatShare = defaultShare,
  limit,
  onShowAll,
  showAllLabel,
  onSelect,
  label,
  className,
}: Readonly<RankedBarsProps>) {
  const ranked = [...items].sort((a, b) => b.value - a.value);
  const shown = limit === undefined ? ranked : ranked.slice(0, limit);
  const max = Math.max(0, ...ranked.map((item) => item.value));
  const total = ranked.reduce((sum, item) => sum + Math.max(item.value, 0), 0);
  const style = { '--rank-color': color } as CSSProperties;

  return (
    <div className={cn('grid gap-2', className)} style={style}>
      <ul className="grid" aria-label={label}>
        {shown.map((item) => {
          const width = max > 0 ? (Math.max(item.value, 0) / max) * 100 : 0;
          const content = (
            <>
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-md bg-[color-mix(in_oklab,var(--rank-color)_16%,transparent)] transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${width}%` }}
              />
              {item.icon && <span className="relative flex size-5 shrink-0 items-center justify-center">{item.icon}</span>}
              <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
              <span className="relative flex shrink-0 items-center text-muted-foreground tabular-nums">
                <span className="absolute right-full mr-3 whitespace-nowrap opacity-0 group-hover/rank:opacity-100 group-focus-within/rank:opacity-100">
                  {formatShare(total > 0 ? Math.max(item.value, 0) / total : 0)}
                </span>
                <span>{item.display}</span>
              </span>
            </>
          );
          const row = 'relative flex h-8 w-full items-center gap-2.5 px-2 text-left text-sm';
          return (
            <li
              key={item.key}
              className="group/rank rounded-md py-0.5 hover:bg-[color-mix(in_oklab,var(--rank-color)_6%,transparent)]"
            >
              {onSelect ? (
                <button type="button" className={cn(row, 'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring')} onClick={() => onSelect(item)}>
                  {content}
                </button>
              ) : (
                <div className={row}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {onShowAll && limit !== undefined && ranked.length > limit && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={onShowAll}>
            {showAllLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
