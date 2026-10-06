/**
 * Actions offered by the header command palette (Create company, Create person).
 *
 * Matching is word-prefix based so "create co" hits Create company, while a
 * record search like "acme" does not. A single character is left to search:
 * "c" would otherwise match every action whose label starts with C.
 */

/** Ignore action matching for a one-character query — that is still a search. */
const MIN_TOKEN_LENGTH = 2;

export interface CommandActionDefinition {
  id: string;
  /** Lowercase words the query is matched against (label tokens + synonyms). */
  keywords: readonly string[];
}

/** Split a label and extra phrases into the lowercase words used for matching. */
export function commandActionKeywords(label: string, synonyms: readonly string[]): string[] {
  const words = new Set<string>();
  for (const source of [label, ...synonyms]) {
    for (const word of source.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word) words.add(word);
    }
  }
  return [...words];
}

/**
 * Actions whose keywords match `query`. An empty query returns every action
 * so they are visible as soon as the palette opens.
 */
export function filterCommandActions<T extends CommandActionDefinition>(
  query: string,
  actions: readonly T[],
): T[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return [...actions];
  if (tokens.length === 1 && tokens[0].length < MIN_TOKEN_LENGTH) return [];
  return actions.filter((action) =>
    tokens.every((token) => action.keywords.some((word) => word.startsWith(token))),
  );
}

/**
 * Extra words, in either maintained locale, so typing "create company" still
 * matches when the visible label is "Bedrijf toevoegen" (and the reverse).
 * The translated label is merged in at render time.
 */
export const CREATE_COMPANY_SYNONYMS = [
  'create',
  'company',
  'companies',
  'customer',
  'new',
  'add',
  'bedrijf',
  'bedrijven',
  'klant',
  'toevoegen',
  'aanmaken',
] as const;

export const CREATE_PERSON_SYNONYMS = [
  'create',
  'person',
  'people',
  'new',
  'add',
  'persoon',
  'personen',
  'toevoegen',
  'aanmaken',
] as const;
