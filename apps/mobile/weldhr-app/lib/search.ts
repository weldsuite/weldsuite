/**
 * Search as you type over a few strings per row. Case and accents do not
 * matter ("cafe" finds "Café"), and every word typed has to appear in one of
 * them, so "lunch okt" narrows the list down to October's lunches.
 */

export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().trim();
}

export function matchesSearch(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields
    .filter((field): field is string => !!field)
    .map(normalizeSearch)
    .join('\n');
  return words.every((word) => haystack.includes(word));
}
