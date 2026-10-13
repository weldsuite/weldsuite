/**
 * Outbound content screen: cheap, synchronous signals from the text of one
 * message. It never blocks a send on its own; the score feeds the ledger's
 * risk score, and the flags pick which templates the AI reviews first.
 *
 * Inbound mail has its own filter (mail-inbound-worker spam-filter.ts), which
 * leans on SPF/DKIM/DMARC results that don't exist for mail we send. This one
 * looks for what cold outreach, bulk mail and phishing say, in English and
 * Dutch. See docs/plans/weldmail-outbound-abuse.md.
 */

import { htmlToText } from '../text';

export interface ContentScreenInput {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  attachments?: Array<{ filename: string; contentType?: string | null }>;
}

export interface ContentScreenResult {
  /** 0 = nothing notable; 3+ = worth a look; capped at 20. */
  score: number;
  reasons: string[];
  flags: {
    coldOutreach: boolean;
    bulk: boolean;
    phishing: boolean;
    links: number;
  };
}

/** Phrases cold outreach is built from. */
const COLD_PHRASES: RegExp[] = [
  /\bquick question\b/,
  /\bi (?:came across|stumbled upon|noticed) (?:your|that your)\b/,
  /\bwould you be open to\b/,
  /\b(?:1[05]|20|30)[- ]?min(?:ute)?s?\b.{0,20}\b(?:call|chat|meeting)\b/,
  /\b(?:book|schedule|grab|hop on) a (?:quick )?(?:call|chat|meeting)\b/,
  /\b(?:are you|who is) the right person\b/,
  /\bif you(?:'re| are) not the right person\b/,
  /\bnot interested\?? (?:just )?(?:reply|let me know)\b/,
  /\b(?:i|we) help (?:companies|businesses|teams|agencies|founders)\b/,
  /\b(?:boost|grow|double|increase) your (?:sales|revenue|leads|pipeline|business)\b/,
  /\bpartnership opportunity\b/,
  /\bworth a (?:quick )?(?:chat|call)\b/,
  /\bjust (?:following up|bumping this)\b/,
  // Dutch
  /\bkort(?:e)? (?:gesprek|kennismaking|belletje)\b/,
  /\b(?:1[05]|20|30) minuten\b/,
  /\bik kwam (?:uw|jullie|je) (?:bedrijf|website|profiel) tegen\b/,
  /\bik zag dat (?:jullie|u|je)\b/,
  /\bvrijblijvend(?:e)? (?:kennismaking|gesprek|offerte|kennismaken)\b/,
  /\bwij helpen (?:bedrijven|organisaties|ondernemers)\b/,
  /\bbent u de juiste persoon\b/,
  /\b(?:even )?sparren\b/,
  /\bafspraak (?:in)?plannen\b/,
];

/** Bulk-mail and spam vocabulary. */
const BULK_PHRASES: RegExp[] = [
  /\bact now\b/,
  /\blimited time\b/,
  /\bguaranteed\b/,
  /\brisk[- ]free\b/,
  /\b100% free\b/,
  /\bclick here\b/,
  /\bearn (?:money|cash|\$)/,
  /\b(?:crypto|bitcoin) (?:opportunity|investment)\b/,
  /\bunsubscribe\b/,
  /\bto stop receiving these emails\b/,
  /\bklik hier\b/,
  /\bnu bestellen\b/,
  /\bafmelden\b/,
  /\btijdelijke? aanbieding\b/,
];

/** Credential and payment lures. */
const PHISHING_PHRASES: RegExp[] = [
  /\bverify your (?:account|identity|email)\b/,
  /\bconfirm your (?:identity|account|password)\b/,
  /\byour (?:password|account) (?:has )?expired?\b/,
  /\bunusual (?:sign[- ]in|login) activity\b/,
  /\byour account (?:will be|has been) (?:suspended|locked|closed)\b/,
  /\bupdate your (?:payment|billing) (?:details|information|method)\b/,
  /\bgift ?cards?\b.{0,40}\b(?:buy|purchase|send)\b/,
  /\bverifieer (?:uw|je) (?:account|identiteit)\b/,
  /\b(?:uw|je) account (?:wordt|is) (?:geblokkeerd|opgeschort)\b/,
  /\bwerk (?:uw|je) betaalgegevens bij\b/,
];

const SHORTENERS = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|t\.ly)\//i;
const BOOKING_LINKS = /\b(?:calendly\.com|cal\.com|savvycal\.com|meetings\.hubspot\.com|zcal\.co|tidycal\.com)\//i;
const LINK_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const PIXEL_RE = /<img\b[^>]*\b(?:width\s*=\s*["']?1(?:px)?["']?[^>]*\bheight\s*=\s*["']?1(?:px)?["']?|height\s*=\s*["']?1(?:px)?["']?[^>]*\bwidth\s*=\s*["']?1(?:px)?["']?)[^>]*>/i;
const RISKY_ATTACHMENT = /\.(?:exe|scr|js|jse|vbs|vbe|bat|cmd|msi|jar|iso|img|lnk|hta|ps1|docm|xlsm|pptm)$/i;

function countMatches(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const re of patterns) if (re.test(text)) hits++;
  return hits;
}

export function screenOutboundContent(input: ContentScreenInput): ContentScreenResult {
  const html = input.html ?? '';
  const plain = `${input.subject ?? ''}\n${input.text || (html ? htmlToText(html) : '')}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const cold = countMatches(plain, COLD_PHRASES);
  if (cold > 0) {
    score += Math.min(cold, 4);
    reasons.push(`cold_phrases:${cold}`);
  }

  const bulk = countMatches(plain, BULK_PHRASES);
  if (bulk > 0) {
    score += Math.min(bulk, 3);
    reasons.push(`bulk_phrases:${bulk}`);
  }

  const phishing = countMatches(plain, PHISHING_PHRASES);
  if (phishing > 0) {
    score += 3 * Math.min(phishing, 2);
    reasons.push(`phishing_phrases:${phishing}`);
  }

  const links = new Set([...(`${plain}\n${html}`.match(LINK_RE) ?? [])]).size;
  if (links >= 5) {
    score += 2;
    reasons.push(`links:${links}`);
  }
  if (SHORTENERS.test(plain) || SHORTENERS.test(html)) {
    score += 2;
    reasons.push('url_shortener');
  }
  if (BOOKING_LINKS.test(plain) || BOOKING_LINKS.test(html)) {
    score += 1;
    reasons.push('booking_link');
  }
  if (html && PIXEL_RE.test(html)) {
    score += 2;
    reasons.push('tracking_pixel');
  }
  const risky = (input.attachments ?? []).filter((a) => RISKY_ATTACHMENT.test(a.filename));
  if (risky.length > 0) {
    score += 3;
    reasons.push('risky_attachment');
  }

  return {
    score: Math.min(score, 20),
    reasons,
    flags: {
      coldOutreach: cold >= 2 || (cold >= 1 && BOOKING_LINKS.test(`${plain}\n${html}`)),
      bulk: bulk >= 2,
      phishing: phishing >= 1 || risky.length > 0,
      links,
    },
  };
}
