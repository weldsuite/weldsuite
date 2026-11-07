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
export const deskPublicArticleHitsSchema = z.array(deskPublicArticleHitSchema);

/**
 * helpdesk-widget-api `GET /api/articles/search?q=&locale=&limit=` answers these.
 * It reads its query leniently and never refuses one: `q` is cut at 200
 * characters, `limit` is 1–5 (default 3), `locale` is the visitor's language.
 */

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
export const deskPublicAnnouncementsSchema = z.array(deskPublicAnnouncementSchema);

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

// Linkify lives in a zod-free module so the widget bundle stays small.
export { linkifyText, type LinkifiedPart } from './desk-linkify';
