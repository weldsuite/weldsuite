/**
 * Pair each item of a list that has no ids with a React key derived from its
 * content. A repeated value (the same image used twice) gets a `#n` suffix, so
 * keys stay unique without falling back to the array index.
 */
export function keyedBy<T>(items: readonly T[], keyOf: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { item, key: count === 1 ? base : `${base}#${count}` };
  });
}
