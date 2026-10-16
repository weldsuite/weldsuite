/**
 * Stripe's "Payments" card body: one stacked bar with a segment per item,
 * then a row per item with its colour square, label and amount, rows split by
 * hairlines. A segment's width is its share of the positive total; an item
 * that is zero or negative keeps its row but gets no segment, and an all-zero
 * breakdown shows an empty bar.
 */

export type BreakdownItem = { key: string; label: string; amount: number; display: string; color: string };

export function BreakdownList({ items }: Readonly<{ items: BreakdownItem[] }>) {
  const total = items.reduce((sum, item) => sum + Math.max(item.amount, 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-[4px] bg-muted">
        {total > 0 &&
          items
            .filter((item) => item.amount > 0)
            .map((item) => (
              <div
                key={item.key}
                className="h-full min-w-0.5 first:rounded-l-[4px] last:rounded-r-[4px]"
                style={{ width: `${(item.amount / total) * 100}%`, backgroundColor: item.color }}
              />
            ))}
      </div>
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-2.5 py-2.5 text-sm">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: item.color }} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className={`font-medium tabular-nums ${item.amount < 0 ? 'text-destructive' : ''}`}>{item.display}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
