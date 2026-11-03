/** A comment card beside the pages: the height it wants to sit at (its text's), or null to follow the one before. */
export interface MarginCard {
  id: string;
  want: number | null;
  height: number;
}

/**
 * Where the comment cards go beside the pages, as in Google Docs: each level
 * with its text, pushed down where it would overlap the one above. The picked
 * card sits exactly at its text, and the cards above it move up to make room.
 * `cards` are in the order they are shown.
 */
export function stackCards(cards: readonly MarginCard[], active: string | null, gap = 8): Map<string, number> {
  const tops: number[] = [];
  let next = 0;
  for (const c of cards) {
    const top = Math.max(c.want ?? next, next);
    tops.push(top);
    next = top + c.height + gap;
  }
  const a = active ? cards.findIndex((c) => c.id === active) : -1;
  const want = a >= 0 ? cards[a]!.want : null;
  if (want !== null && tops[a]! > want) {
    tops[a] = want;
    for (let i = a + 1; i < cards.length; i++) tops[i] = Math.max(cards[i]!.want ?? -Infinity, tops[i - 1]! + cards[i - 1]!.height + gap);
    for (let i = a - 1; i >= 0; i--) tops[i] = Math.min(tops[i]!, tops[i + 1]! - cards[i]!.height - gap);
  }
  return new Map(cards.map((c, i) => [c.id, tops[i]!]));
}
