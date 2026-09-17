/**
 * Heuristic inbound promotion classifier for WeldMail.
 *
 * Pure functions — no DB / network. Decides whether a (non-spam) inbound
 * message is marketing / bulk mail that belongs under the PROMOTIONS system
 * label instead of INBOX.
 *
 * The classifier leans on the signals bulk senders are required to emit
 * (List-Unsubscribe, Precedence: bulk, ESP campaign headers) and only uses
 * the marketing lexicon to tip a message over the threshold. Transactional
 * mail (receipts, password resets, verification codes) is pulled back below
 * the threshold even when it comes from the same ESP, and replies in a
 * conversation are never classified as promotions.
 */

/** Score at or above this value is treated as a promotion. */
export const PROMOTION_SCORE_THRESHOLD = 4;

/** Headers set by marketing platforms on campaign sends (lower-case). */
const CAMPAIGN_HEADERS = [
  'x-campaign',
  'x-campaignid',
  'x-campaign-id',
  'x-mailchimp-campaign',
  'x-mc-user',
  'x-mailin-campaign',
  'x-klaviyo-message-id',
  'x-hs-campaign-id',
  'x-marketo-id',
  'x-newsletter',
  'x-list-id',
];

/** EN + NL marketing phrases, matched against the subject. */
const PROMOTION_SUBJECT_LEXICON = [
  '% off',
  'sale',
  'discount',
  'coupon',
  'promo code',
  'deal',
  'deals',
  'limited time',
  'last chance',
  'free shipping',
  'black friday',
  'cyber monday',
  'shop now',
  'new arrivals',
  'newsletter',
  'exclusive offer',
  'korting',
  'aanbieding',
  'uitverkoop',
  'gratis verzending',
  'nieuwsbrief',
  'laatste kans',
];

/** Opt-out wording that marketing footers carry. */
const UNSUBSCRIBE_LEXICON = ['unsubscribe', 'afmelden', 'uitschrijven', 'opt out', 'opt-out'];

/** Transactional wording — pulls a message back out of promotions. */
const TRANSACTIONAL_LEXICON = [
  'receipt',
  'invoice',
  'order confirmation',
  'your order',
  'has shipped',
  'password',
  'verification code',
  'verify your',
  'security alert',
  'sign-in',
  'login code',
  'factuur',
  'bestelling',
  'orderbevestiging',
  'wachtwoord',
  'verificatiecode',
  'beveiligingsmelding',
];

export interface PromotionClassifyEmail {
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  headers?: Record<string, string>;
}

export interface PromotionClassifyOptions {
  /** Message is a reply / continuation of a conversation. */
  isReply?: boolean;
}

export interface PromotionClassifyResult {
  isPromotion: boolean;
  score: number;
  reasons: string[];
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return headerValue(headers, name) !== undefined;
}

/** Word-boundary match so "sale" does not hit "wholesale" or "salesforce". */
function containsPhrase(text: string, phrase: string): boolean {
  if (/^\W/.test(phrase)) return text.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

export function classifyPromotion(
  email: PromotionClassifyEmail,
  options: PromotionClassifyOptions = {},
): PromotionClassifyResult {
  const reasons: string[] = [];

  if (options.isReply) {
    return { isPromotion: false, score: 0, reasons: ['reply'] };
  }

  let score = 0;
  const headers = email.headers;

  if (hasHeader(headers, 'list-unsubscribe')) {
    score += 2;
    reasons.push('list_unsubscribe');
  }
  if (hasHeader(headers, 'list-unsubscribe-post')) {
    score += 1;
    reasons.push('list_unsubscribe_post');
  }

  const precedence = headerValue(headers, 'precedence')?.trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'list') {
    score += 1;
    reasons.push('precedence_bulk');
  }

  if (CAMPAIGN_HEADERS.some((h) => hasHeader(headers, h))) {
    score += 2;
    reasons.push('campaign_header');
  }

  const subject = (email.subject ?? '').toLowerCase();
  if (PROMOTION_SUBJECT_LEXICON.some((p) => containsPhrase(subject, p))) {
    score += 2;
    reasons.push('subject_marketing');
  }

  const body = `${email.textBody ?? ''} ${email.htmlBody ?? ''}`.toLowerCase();
  if (UNSUBSCRIBE_LEXICON.some((p) => containsPhrase(body, p))) {
    score += 1;
    reasons.push('body_unsubscribe');
  }

  if (TRANSACTIONAL_LEXICON.some((p) => containsPhrase(subject, p))) {
    score -= 4;
    reasons.push('subject_transactional');
  }

  return { isPromotion: score >= PROMOTION_SCORE_THRESHOLD, score, reasons };
}
