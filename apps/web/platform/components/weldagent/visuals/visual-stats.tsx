/** Stat tiles from a `show_stats` spec, on the library's `KpiGrid` / `KpiCard`. */

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { StatItem, StatsVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { cn } from '@/lib/utils';
import { formatChange, formatValue } from './format';

/** The coloured change line under a value: green when it went the good way. */
function ChangeHint({ item, locale }: Readonly<{ item: StatItem; locale: string }>) {
  if (item.change === undefined && !item.changeLabel) return null;
  if (item.change === undefined) return <span>{item.changeLabel}</span>;
  const good = item.positiveIsGood === false ? item.change < 0 : item.change > 0;
  let Icon = Minus;
  if (item.change > 0) Icon = ArrowUpRight;
  else if (item.change < 0) Icon = ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          'inline-flex items-center gap-0.5 font-medium tabular-nums',
          item.change === 0 && 'text-muted-foreground',
          item.change !== 0 && good && 'text-emerald-600 dark:text-emerald-400',
          item.change !== 0 && !good && 'text-destructive',
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {formatChange(item.change, locale)}
      </span>
      {item.changeLabel && <span>{item.changeLabel}</span>}
    </span>
  );
}

interface VisualStatsProps {
  visual: StatsVisual;
  locale: string;
  /** A tile was clicked: ask about it. */
  onPick?: (item: StatItem, formatted: string) => void;
  askLabel?: (label: string) => string;
}

export function VisualStats({ visual, locale, onPick, askLabel }: Readonly<VisualStatsProps>) {
  return (
    <KpiGrid fit="container">
      {visual.items.map((item, i) => {
        const value = formatValue(item.value, item.format, locale);
        const card = (
          <KpiCard
            label={item.label}
            value={<span className="text-xl @[20rem]:text-2xl">{value}</span>}
            hint={<ChangeHint item={item} locale={locale} />}
            interactive={!!onPick}
          />
        );
        if (!onPick) return <div key={`${item.label}-${i}`}>{card}</div>;
        return (
          <button
            key={`${item.label}-${i}`}
            type="button"
            className="block rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onPick(item, value)}
            title={askLabel?.(item.label)}
          >
            {card}
          </button>
        );
      })}
    </KpiGrid>
  );
}
