/**
 * Build safe FTS5 MATCH arguments for mail search (design Decisions #3, §3.3).
 *
 * Two tables per mailbox:
 *  - `messages_fts_meta`, `tokenize='trigram'` over subject, from and to/cc
 *    addresses and names: substring semantics, so the MATCH argument is the
 *    trimmed query quoted as one FTS5 phrase literal (trigram matching looks
 *    for the substring directly; it does not use the boolean-operator
 *    grammar), with a literal `"` escaped.
 *  - `messages_fts_body`, `unicode61 remove_diacritics 2`, `detail=column`,
 *    over the first 8 KB of body text: token-prefix semantics, so the
 *    argument is `tok1* AND tok2* ...` — never a phrase, which `detail=column`
 *    rejects (design §3.3).
 *
 * Both builders split on non-letter/digit and lower-case every token, so
 * `AND`/`OR`/`NOT` typed by a user are read as ordinary lower-case words, not
 * FTS5 operators (which are recognised only upper-case) — user input can
 * never inject MATCH syntax.
 *
 * No I/O: safe in the object, in a worker, and in a test.
 */

/** Unicode-aware "word" splitter: runs of letters or digits. */
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

function tokenize(input: string): string[] {
  return (input.match(WORD_PATTERN) ?? []).map((t) => t.toLowerCase());
}

/**
 * Quote a string as one FTS5 phrase literal: internal `"` doubled, per the
 * FTS5 query grammar. Wrapping the whole input neutralises every operator
 * (`AND`, `OR`, `NOT`, `-`, `*`, parens, column filters) — inside a quoted
 * phrase they are just text.
 */
export function quoteFtsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The `messages_fts_meta` MATCH argument for a free-text search: the trimmed
 * query as one quoted phrase. `null` for an empty/blank search.
 */
export function buildMetaMatchQuery(search: string | null | undefined): string | null {
  const trimmed = search?.trim();
  if (!trimmed) return null;
  return quoteFtsPhrase(trimmed);
}

/**
 * The `messages_fts_body` MATCH argument: every term lower-cased and
 * prefix-matched, ANDed together (a message must contain all of them). `null`
 * when the search has no word characters at all (only punctuation/emoji).
 */
export function buildBodyMatchQuery(search: string | null | undefined): string | null {
  if (!search) return null;
  const tokens = tokenize(search);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(' AND ');
}

export interface MailFtsQuery {
  /** `null` when the search has no substring-indexable text (never happens in practice: the trimmed query itself is always non-empty here). */
  meta: string | null;
  /** `null` when the search has no word characters to prefix-match. */
  body: string | null;
}

/** Both MATCH arguments for a search string, or `null` when there is nothing to search for. */
export function buildMailSearchQuery(search: string | null | undefined): MailFtsQuery | null {
  const trimmed = search?.trim();
  if (!trimmed) return null;
  return { meta: buildMetaMatchQuery(trimmed), body: buildBodyMatchQuery(trimmed) };
}

/**
 * The `messages_fts_body` MATCH argument for "doesn't have any of these
 * words" (design §3.3 `excludeWords`): every word prefix-matched, ORed — a
 * thread is excluded when ANY word appears in ANY of its messages.
 */
export function buildExcludeWordsMatchQuery(words: string | null | undefined): string | null {
  if (!words) return null;
  const tokens = tokenize(words);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(' OR ');
}
