/**
 * Pair each item of a list that has no ids with a React key derived from its
 * content. A repeated value (the same image used twice) gets a `#n` suffix, so
 * keys stay unique without falling back to the array index. A generated suffix
 * that happens to equal another item's own key is skipped, so every emitted key
 * is unique.
 */
export function keyedBy<T>(items: readonly T[], keyOf: (item: T) => string): { item: T; key: string }[] {
  const bases = items.map(keyOf);
  const used = new Set<string>();
  const reserved = new Set(bases);
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const base = bases[index]!;
    let count = seen.get(base) ?? 0;
    let key = base;
    if (used.has(key)) {
      do {
        count += 1;
        key = `${base}#${count + 1}`;
      } while (used.has(key) || reserved.has(key));
    }
    seen.set(base, count);
    used.add(key);
    return { item, key };
  });
}

/** An unambiguous key for a tuple of optional fields (no separator collisions). */
export function tupleKey(...parts: ReadonlyArray<string | number | null | undefined>): string {
  return JSON.stringify(parts);
}
