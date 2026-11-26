/**
 * The `search` of a list: every word of the text has to appear, in any case,
 * in at least one of the columns. So `acme rollout` finds "Acme – Platform
 * rollout" and `password reset` finds "Resetting your password", which a
 * case-sensitive `like '%text%'` on the whole text did not. AI clients
 * search in their own words (MCP), so the words matter, not the phrase.
 *
 * The Rust backend matches the same way (`search_any` in
 * `rust/modules/external-api/src/list.rs`).
 */

import { and, ilike, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';

/** `%`, `_` and the escape character itself, so a LIKE pattern matches the text literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * `(a ilike '%one%' or b ilike '%one%') and (a ilike '%two%' or …)`. `%`, `_`
 * and `\` in the text match themselves; text without words matches every row.
 */
export function searchAny(search: string, columns: AnyColumn[]): SQL {
  const words = search.split(/\s+/).filter(Boolean);
  const matches = words.map((word) => {
    const pattern = `%${escapeLike(word)}%`;
    return or(...columns.map((column) => ilike(column, pattern)));
  });
  return and(...matches) ?? sql`true`;
}
