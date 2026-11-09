/**
 * WeldDesk knowledge for readers and agents: who may read an article or an
 * announcement, article search, language versions and help-center links.
 *
 * Readers. A reader is anonymous or has a verified email (a signed-in
 * help-center reader, an identified widget visitor). Their CRM companies are
 * the companies of the CRM people with that email (`people.email` or
 * `alternate_emails`) through current `person_companies` rows. An article is
 * readable when it is `public`, `logged_in` and the reader has a verified
 * email, or `groups` and one of its `audienceCompanyIds` is the reader's
 * company. `internal` never is. Announcements: `public`, or `specific_groups`
 * with `targetGroups` as company ids, the same rule.
 *
 * Search. Postgres full-text search with the `simple` configuration (no
 * stemming or stop words, so any language works): title weighted A, excerpt
 * B, content (tags stripped) C, ranked by `ts_rank`. A typed query is
 * `websearch_to_tsquery` OR every word with the last as a prefix (typeahead);
 * "related" text (a customer's messages) is an OR of its longer words, and so
 * is what a customer writes before sending a request (deflection), with the
 * word still being typed as a prefix.
 *
 * Language versions. A version is an article row with `translationOfId` (the
 * original) and its own `locale`. Lists show one entry per original: the
 * version in the reader's language when it is published and readable, else
 * the original.
 *
 * Rust twin: `rust/crates/desk-domain/src/articles.rs` (same SQL).
 */

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { DeskMessage } from '../schema/desk-messages';
import { normalizeDeskEmail } from './desk-portal';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const articles = schema.helpdeskArticles;

// ============================================================================
// Readers
// ============================================================================

export interface DeskReader {
  /** Lower-cased proven email; null for an anonymous reader. */
  verifiedEmail: string | null;
  /** The reader's CRM companies (sorted); empty when anonymous. */
  companyIds: string[];
}

export const DESK_ANONYMOUS_READER: DeskReader = { verifiedEmail: null, companyIds: [] };

/** A jsonb column as an array of text, `[]` when it holds anything else. */
const jsonbTextArray = (column: SQL | string) =>
  sql.raw(`jsonb_array_elements_text(case when jsonb_typeof(${column}) = 'array' then ${column} else '[]'::jsonb end)`);

/** The live CRM companies of the live CRM people with this email, sorted. */
export async function deskCompanyIdsForEmail(db: AnyDb, email: string): Promise<string[]> {
  const address = normalizeDeskEmail(email);
  if (!address) return [];
  const rows = (await db.execute(sql`
    select distinct pc.company_id as id
    from person_companies pc
    join people p on p.id = pc.person_id
    join companies co on co.id = pc.company_id
    where p.deleted_at is null and co.deleted_at is null
      and (pc.ended_at is null or pc.ended_at > now())
      and (lower(p.email) = ${address}
        or exists (select 1 from ${jsonbTextArray('p.alternate_emails')} as alt(v) where lower(alt.v) = ${address}))
    order by pc.company_id
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return list.map((row) => String(row.id));
}

/** The reader a principal is: anonymous without a verified email. */
export async function deskReaderOf(
  db: AnyDb,
  principal: { verifiedEmail: string | null } | null | undefined,
): Promise<DeskReader> {
  const email = principal?.verifiedEmail ? normalizeDeskEmail(principal.verifiedEmail) : null;
  if (!email) return DESK_ANONYMOUS_READER;
  return { verifiedEmail: email, companyIds: await deskCompanyIdsForEmail(db, email) };
}

/** `alias.<audience column>` holds one of the reader's companies. */
function audienceMatches(column: string, reader: DeskReader): SQL {
  const ids = sql.join(reader.companyIds.map((id) => sql`${id}`), sql`, `);
  return sql`exists (select 1 from ${jsonbTextArray(column)} as aud(v) where aud.v in (${ids}))`;
}

/** Joins alternative conditions. */
const SQL_OR = sql` or `;

/** The SQL condition "the reader may read article row `alias`" (status and deletion aside). */
export function deskArticleVisibleTo(alias: string, reader: DeskReader): SQL {
  const a = sql.raw(alias);
  const parts: SQL[] = [sql`${a}.visibility = 'public'`];
  if (reader.verifiedEmail) parts.push(sql`${a}.visibility = 'logged_in'`);
  if (reader.companyIds.length > 0) {
    const audienceColumn = `${alias}.audience_company_ids`;
    parts.push(sql`(${a}.visibility = 'groups' and ${audienceMatches(audienceColumn, reader)})`);
  }
  return sql`(${sql.join(parts, SQL_OR)})`;
}

/** Published, not deleted and readable: article row `alias`. */
export function deskArticleLiveFor(alias: string, reader: DeskReader): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'published' and ${a}.deleted_at is null and ${deskArticleVisibleTo(alias, reader)})`;
}

// ============================================================================
// Search
// ============================================================================

/** What a search runs: `websearch_to_tsquery` text and/or a `to_tsquery` expression. */
export interface DeskArticleSearch {
  websearch: string | null;
  tsquery: string | null;
}

/** Words of a text: runs of letters and digits, lower-cased. */
export function deskSearchWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A typed query (typeahead): the text as `websearch_to_tsquery` takes it, OR
 * its first eight words with the last one a prefix (`'reset' & 'pass':*`).
 * Null when it has no words: there is nothing to search for.
 */
export function deskTypedSearch(text: string): DeskArticleSearch | null {
  const term = Array.from(text.trim()).slice(0, 200).join('');
  const words = deskSearchWords(term).slice(0, 8);
  if (words.length === 0) return null;
  const prefix = words.map((word, i) => (i === words.length - 1 ? `'${word}':*` : `'${word}'`)).join(' & ');
  return { websearch: term, tsquery: prefix };
}

/**
 * Text to find related articles for (a customer's messages): an OR of its
 * distinct words of four characters or more, at most twelve, in order.
 */
export function deskRelatedSearch(text: string): DeskArticleSearch | null {
  const words: string[] = [];
  for (const word of deskSearchWords(text)) {
    if (Array.from(word).length < 4 || words.includes(word)) continue;
    words.push(word);
    if (words.length === 12) break;
  }
  if (words.length === 0) return null;
  return { websearch: null, tsquery: words.map((word) => `'${word}'`).join(' | ') };
}

/**
 * What a customer is writing before they send a request (deflection): an OR
 * of its distinct words of four characters or more, at most twelve, in
 * order, the one still being typed (the text ends on it) as a prefix. A
 * question is a sentence, and an article about resetting a password rarely
 * holds every "how", "do" and "my" of it, so a typed search (every word)
 * finds nothing; the rank puts the articles with the most of its words
 * first. Text with only short words ("vpn", "2fa") is searched as typed.
 */
export function deskSuggestSearch(text: string): DeskArticleSearch | null {
  const term = Array.from(text.trim()).slice(0, 200).join('');
  const all = deskSearchWords(term);
  const words: string[] = [];
  for (const word of all) {
    if (Array.from(word).length < 4 || words.includes(word)) continue;
    words.push(word);
    if (words.length === 12) break;
  }
  if (words.length === 0) return deskTypedSearch(term);
  const typing = /[\p{L}\p{N}]$/u.test(term) ? all[all.length - 1] : null;
  const last = words.length - 1;
  return {
    websearch: null,
    tsquery: words.map((word, i) => (i === last && word === typing ? `'${word}':*` : `'${word}'`)).join(' | '),
  };
}

/** The tsquery of a search. */
export function deskArticleQuery(search: DeskArticleSearch): SQL {
  const { websearch, tsquery } = search;
  if (websearch !== null && tsquery !== null) {
    return sql`(websearch_to_tsquery('simple', ${websearch}) || to_tsquery('simple', ${tsquery}))`;
  }
  if (websearch !== null) return sql`websearch_to_tsquery('simple', ${websearch})`;
  return sql`to_tsquery('simple', ${tsquery ?? ''})`;
}

/** The weighted document of article row `alias`. */
export function deskArticleDocument(alias: string): SQL {
  return sql.raw(
    `(setweight(to_tsvector('simple', coalesce(${alias}.title, '')), 'A')` +
      ` || setweight(to_tsvector('simple', coalesce(${alias}.excerpt, '')), 'B')` +
      ` || setweight(to_tsvector('simple', regexp_replace(coalesce(${alias}.content, ''), '<[^>]*>', ' ', 'g')), 'C'))`,
  );
}

/** Article row `alias` matches the search. */
export function deskArticleMatches(alias: string, search: DeskArticleSearch): SQL {
  return sql`${deskArticleDocument(alias)} @@ ${deskArticleQuery(search)}`;
}

/** Its rank for the search (higher first). */
export function deskArticleRank(alias: string, search: DeskArticleSearch): SQL {
  return sql`ts_rank(${deskArticleDocument(alias)}, ${deskArticleQuery(search)})`;
}

// ============================================================================
// Language versions
// ============================================================================

/**
 * An article slug from a title: lower case, each run of anything but
 * `[a-z0-9]` one dash, no dash at either end, at most 500 characters. The
 * routes append part of the row id, so two articles never share one.
 */
export function deskArticleSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 500);
}

/** `nl`, `pt-br`: a locale as stored (lower case), null when there is none. */
export function normalizeDeskLocale(locale: string | null | undefined): string | null {
  const value = locale?.trim().toLowerCase();
  return value ? value : null;
}

/**
 * The ids of what a reader's list shows (optionally only in one folder): per
 * readable published original, its readable published version in `locale`,
 * else the original itself. The folder is the original's.
 */
export function deskDisplayedArticleIds(reader: DeskReader, locale: string | null, folderId?: string | null): SQL {
  const folder = folderId ? sql` and o.category_id = ${folderId}` : sql``;
  const pick = locale
    ? sql`coalesce((select x.id from helpdesk_articles x where x.translation_of_id = o.id and x.locale = ${locale} and ${deskArticleLiveFor('x', reader)} order by x.created_at asc, x.id asc limit 1), o.id)`
    : sql`o.id`;
  return sql`(select ${pick} from helpdesk_articles o where o.translation_of_id is null and ${deskArticleLiveFor('o', reader)}${folder})`;
}

/**
 * The folder an article row is listed under: its original's. Spelled out with
 * the table name: Drizzle leaves a single-table select's columns unqualified,
 * which inside the subquery would name `o`'s.
 */
export const deskArticleFolderId = sql<string | null>`${sql.raw(
  'coalesce((select o.category_id from helpdesk_articles o where o.id = helpdesk_articles.translation_of_id), helpdesk_articles.category_id)',
)}`;

/** A version the reader may open, for links between languages. */
export interface DeskArticleVersionLink {
  locale: string | null;
  slug: string;
  title: string;
}

/**
 * The published, readable article with this slug: an original, or a version
 * whose original is published and readable too.
 */
export async function findDeskReadableArticle(db: AnyDb, slug: string, reader: DeskReader) {
  const [row] = await db
    .select()
    .from(articles)
    .where(
      and(
        eq(articles.slug, slug),
        deskArticleLiveFor('helpdesk_articles', reader),
        sql`(helpdesk_articles.translation_of_id is null or exists (select 1 from helpdesk_articles o where o.id = helpdesk_articles.translation_of_id and ${deskArticleLiveFor('o', reader)}))`,
      ),
    )
    .orderBy(asc(articles.createdAt), asc(articles.id))
    .limit(1);
  return row ?? null;
}

/** Every readable published version of the article `rootId` (the original first, then by locale). */
export async function listDeskArticleVersionLinks(
  db: AnyDb,
  rootId: string,
  reader: DeskReader,
): Promise<DeskArticleVersionLink[]> {
  return db
    .select({ locale: articles.locale, slug: articles.slug, title: articles.title })
    .from(articles)
    .where(
      and(
        sql`(${articles.id} = ${rootId} or ${articles.translationOfId} = ${rootId})`,
        deskArticleLiveFor('helpdesk_articles', reader),
      ),
    )
    .orderBy(sql`(${articles.translationOfId} is not null)`, sql`${articles.locale} asc nulls first`, asc(articles.id));
}

// ============================================================================
// Help-center links
// ============================================================================

/** `https://<host>` of the live help center (custom domain first), null when it is off or has no domain. */
export async function deskHelpCenterBaseUrl(db: AnyDb): Promise<string | null> {
  const s = schema.helpcenterSettings;
  const [settings] = await db
    .select({ isEnabled: s.isEnabled, defaultSubdomain: s.defaultSubdomain, customDomain: s.customDomain })
    .from(s)
    .where(isNull(s.deletedAt))
    .orderBy(asc(s.createdAt), asc(s.id))
    .limit(1);
  if (!settings || settings.isEnabled !== 1) return null;
  const host = (settings.customDomain?.trim() || settings.defaultSubdomain?.trim() || '').toLowerCase();
  return host ? `https://${host}` : null;
}

/** An article's help-center page. */
export function deskArticleUrl(baseUrl: string | null, slug: string): string | null {
  return baseUrl ? `${baseUrl}/articles/${slug}` : null;
}

// ============================================================================
// Reader search (widget) and agent suggestions (inbox)
// ============================================================================

export interface DeskArticleHit {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  url: string | null;
}

/** What a reader's search finds: the displayed versions that match, best first. */
export async function searchDeskArticlesFor(
  db: AnyDb,
  reader: DeskReader,
  search: DeskArticleSearch,
  opts: { locale: string | null; limit: number },
): Promise<DeskArticleHit[]> {
  const [rows, baseUrl] = await Promise.all([
    db
      .select({ id: articles.id, title: articles.title, slug: articles.slug, excerpt: articles.excerpt })
      .from(articles)
      .where(
        and(
          sql`${articles.id} in ${deskDisplayedArticleIds(reader, opts.locale)}`,
          deskArticleMatches('helpdesk_articles', search),
        ),
      )
      .orderBy(desc(deskArticleRank('helpdesk_articles', search)), desc(articles.updatedAt), desc(articles.id))
      .limit(opts.limit),
    deskHelpCenterBaseUrl(db),
  ]);
  return rows.map((row) => ({ ...row, url: deskArticleUrl(baseUrl, row.slug) }));
}

export interface DeskArticleSuggestionRow {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  visibility: string;
  locale: string | null;
  url: string | null;
}

/** Visibilities an agent may hand a customer (every published, non-internal article and version). */
export const DESK_SHAREABLE_VISIBILITIES = ['public', 'logged_in', 'groups'] as const;

/**
 * Published, shareable articles (originals and versions) matching the search,
 * best first. A version counts only while its original is published and
 * shareable too: the help center serves it under the same rule
 * (`findDeskReadableArticle`), so its link would open nothing otherwise.
 */
export async function suggestDeskArticles(
  db: AnyDb,
  search: DeskArticleSearch,
  limit: number,
  baseUrl: string | null,
): Promise<DeskArticleSuggestionRow[]> {
  const rows = await db
    .select({
      id: articles.id,
      title: articles.title,
      slug: articles.slug,
      excerpt: articles.excerpt,
      visibility: articles.visibility,
      locale: articles.locale,
    })
    .from(articles)
    .where(
      and(
        eq(articles.status, 'published'),
        isNull(articles.deletedAt),
        sql`${articles.visibility} in ('public', 'logged_in', 'groups')`,
        sql`(helpdesk_articles.translation_of_id is null or exists (select 1 from helpdesk_articles o where o.id = helpdesk_articles.translation_of_id and o.status = 'published' and o.deleted_at is null and o.visibility in ('public', 'logged_in', 'groups')))`,
        deskArticleMatches('helpdesk_articles', search),
      ),
    )
    .orderBy(desc(deskArticleRank('helpdesk_articles', search)), desc(articles.updatedAt), desc(articles.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, url: deskArticleUrl(baseUrl, row.slug) }));
}

// ============================================================================
// Announcements
// ============================================================================

export interface DeskAnnouncementForReader {
  id: string;
  title: string;
  content: string;
  excerpt: string | null;
  type: string;
  isPinned: boolean;
  publishedAt: string | null;
  expiresAt: string | null;
}

/** Published, started, unexpired announcements the reader may see: pinned first, newest first, at most 20. */
export async function listDeskAnnouncementsFor(db: AnyDb, reader: DeskReader): Promise<DeskAnnouncementForReader[]> {
  const a = schema.helpdeskAnnouncements;
  const audience: SQL[] = [sql`${a.visibility} = 'public'`];
  if (reader.companyIds.length > 0) {
    audience.push(sql`(${a.visibility} = 'specific_groups' and ${audienceMatches('helpdesk_announcements.target_groups', reader)})`);
  }
  const rows = await db
    .select({
      id: a.id,
      title: a.title,
      content: a.content,
      excerpt: a.excerpt,
      type: a.type,
      isPinned: a.isPinned,
      publishedAt: a.publishedAt,
      expiresAt: a.expiresAt,
    })
    .from(a)
    .where(
      and(
        isNull(a.deletedAt),
        eq(a.status, 'published'),
        sql`(${a.publishedAt} is null or ${a.publishedAt} <= now())`,
        sql`(${a.expiresAt} is null or ${a.expiresAt} > now())`,
        sql`(${sql.join(audience, SQL_OR)})`,
      ),
    )
    .orderBy(
      sql`coalesce(${a.isPinned}, false) desc`,
      sql`${a.publishedAt} desc nulls last`,
      desc(a.createdAt),
      desc(a.id),
    )
    .limit(20);
  return rows.map((row) => ({
    ...row,
    isPinned: row.isPinned === true,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }));
}

// ============================================================================
// A draft article from a conversation
// ============================================================================

/** The first `n` code points of a string. */
function firstChars(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One message as a paragraph: escaped, its lines kept apart. */
function paragraph(body: string): string {
  return `<p>${escapeHtml(body.trim().replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>')}</p>`;
}

/** Runs of spaces, tabs and line breaks as one space. */
function collapse(text: string): string {
  return text.replace(/[\r\n\t ]+/g, ' ').trim();
}

export interface DeskArticleDraft {
  title: string;
  content: string;
  excerpt: string | null;
}

/**
 * A draft article from a conversation's timeline (oldest first): the
 * customer's messages quoted, then the team's public replies, as the article
 * editor's HTML. The title is the conversation's, else the first line of the
 * customer's first message, else `#<number>`; at most 200 characters.
 */
export function deskArticleDraftFrom(
  conversation: { title: string | null; conversationNumber: number },
  messages: ReadonlyArray<Pick<DeskMessage, 'kind' | 'authorType' | 'body'>>,
): DeskArticleDraft {
  const said = (authorType: string) =>
    messages
      .filter((m) => m.kind === 'message' && m.authorType === authorType && m.body?.trim())
      .map((m) => m.body as string);
  const customer = said('visitor');
  const team = said('agent');

  const firstLine = customer[0]?.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const title = firstChars(conversation.title?.trim() || firstLine || `#${conversation.conversationNumber}`, 200);

  const parts: string[] = [];
  if (customer.length > 0) parts.push(`<blockquote>${customer.map(paragraph).join('')}</blockquote>`);
  parts.push(...team.map(paragraph));
  const content = parts.join('') || '<p></p>';

  const excerpt = customer[0] ? firstChars(collapse(customer[0]), 200) || null : null;
  return { title, content, excerpt };
}
