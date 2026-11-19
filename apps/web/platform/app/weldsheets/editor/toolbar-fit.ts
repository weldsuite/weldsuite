/**
 * How many leading groups of a toolbar fit in `available` px, given each group's
 * width and the `gap` between them. When not all fit, room is kept for the
 * trailing "More" button (`moreWidth`).
 */
export function fitGroups(widths: readonly number[], available: number, moreWidth: number, gap = 2): number {
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.length;
  const budget = available - moreWidth - gap;
  let used = 0;
  let count = 0;
  for (const w of widths) {
    const next = used + w + (count > 0 ? gap : 0);
    if (next > budget) break;
    used = next;
    count++;
  }
  return count;
}
