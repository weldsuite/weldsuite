/**
 * WeldDesk knowledge and self-service: what the inbox, the chat widget and
 * the help center share about articles and announcements.
 *
 * - Article suggestions in the inbox composer
 *   (`GET /api/desk/conversations/:id/article-suggestions`, desk-api).
 * - Article search for readers: the widget's deflection before a request is
 *   sent (`GET /api/articles/search`, helpdesk-widget-api) and the help
 *   center's request form (desk-api `/public/helpcenter/search`).
 * - Status banners: published announcements a reader may see
 *   (helpdesk-widget-api `GET /api/announcements`, desk-api
 *   `/public/helpcenter/announcements`).
 * - `linkifyText`: URLs in a plain-text message body as links.
 */
import { z } from 'zod';

// ============================================================================
// Inbox: suggestions for a conversation
// ============================================================================

/** One article the composer offers. `url` is its help-center page, null when no help center is live. */
export const deskArticleSuggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  /** `public`, `logged_in` or `groups` (internal articles are never offered). */
  visibility: z.string(),
  locale: z.string().nullable(),
  url: z.string().nullable(),
});
export type DeskArticleSuggestion = z.infer<typeof deskArticleSuggestionSchema>;

/**
 * `GET /api/desk/conversations/:id/article-suggestions?q=&limit=`: with `q`,
 * a search; without it, articles related to the customer's latest messages.
 * `helpCenterUrl` is the live help center's origin (`https://help.acme.com`),
 * null when the help center is off or has no domain.
 */
export const deskArticleSuggestionsSchema = z.object({
  helpCenterUrl: z.string().nullable(),
  query: z.string(),
  articles: z.array(deskArticleSuggestionSchema),
});
export type DeskArticleSuggestions = z.infer<typeof deskArticleSuggestionsSchema>;

export const deskArticleSuggestionsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

// ============================================================================
// Readers: article search (widget, help-center request form)
// ============================================================================

/** An article a reader may open: in the help center when it is live (`url`), else from its excerpt. */
export const deskPublicArticleHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  url: z.string().nullable(),
});
export type DeskPublicArticleHit = z.infer<typeof deskPublicArticleHitSchema>;

/** helpdesk-widget-api `GET /api/articles/search` query. */
export const deskWidgetArticleSearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** The visitor's language (`nl`); a version in it is preferred. */
  locale: z.string().max(10).optional(),
  limit: z.coerce.number().int().min(1).max(5).optional(),
});

// ============================================================================
// Readers: announcements (status banners)
// ============================================================================

export const DESK_ANNOUNCEMENT_TYPES = ['info', 'warning', 'success', 'error'] as const;
export type DeskAnnouncementType = (typeof DESK_ANNOUNCEMENT_TYPES)[number];

/** A published, unexpired announcement the reader may see. `content` is plain text. */
export const deskPublicAnnouncementSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  excerpt: z.string().nullable(),
  type: z.string(),
  isPinned: z.boolean(),
  publishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type DeskPublicAnnouncement = z.infer<typeof deskPublicAnnouncementSchema>;

// ============================================================================
// Help center: an article's language versions
// ============================================================================

/** One language version linked from an article page; `locale` null = the help center's default language. */
export const deskArticleVersionLinkSchema = z.object({
  locale: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
});
export type DeskArticleVersionLink = z.infer<typeof deskArticleVersionLinkSchema>;

/** Languages the article editor offers for a version. */
export const DESK_ARTICLE_LANGUAGES = ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'da', 'sv', 'nb', 'fi', 'pl'] as const;

// ============================================================================
// Linkify
// ============================================================================

export type LinkifiedPart = { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

/** `https://…`, `http://…` or `www.…`, up to whitespace or a `<`. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<]+/gi;
/** Punctuation that usually ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?'"]+$/;

/**
 * Split a plain-text message into text and links, for rendering URLs as
 * anchors (never as HTML: callers render each part as text or an `<a>`).
 * A closing bracket at the end is left out unless the URL opened one.
 */
export function linkifyText(text: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];
    let trimmed = true;
    while (trimmed) {
      trimmed = false;
      const punctuation = TRAILING.exec(url);
      if (punctuation) {
        url = url.slice(0, -punctuation[0].length);
        trimmed = true;
      }
      for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
        if (url.endsWith(close) && url.split(open).length < url.split(close).length) {
          url = url.slice(0, -1);
          trimmed = true;
        }
      }
    }
    if (!url || /^www\.?$/i.test(url)) continue;
    if (start > last) parts.push({ type: 'text', text: text.slice(last, start) });
    parts.push({ type: 'link', text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}
