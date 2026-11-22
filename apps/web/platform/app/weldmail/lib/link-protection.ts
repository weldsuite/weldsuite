/**
 * Click-time link protection (edition feature `mail-threat-protection`).
 *
 * A received message's links are rewritten to the platform's own interstitial
 * page, `/weldmail/link#m=<messageId>&u=<url>&t=<visible text>`, which asks the
 * server to check the destination and then forwards the reader, warns them, or
 * blocks the link. The target travels in the URL fragment, never the query
 * string: a fragment is not sent to any server, so the address a person was
 * mailed never lands in an access log.
 *
 * Pure functions only; the DOM rewrite takes the anchors it is handed.
 */

import { workspacePath } from '@/lib/workspace-url';
import type { MailLinkCheckResult } from '@weldsuite/app-api-client/schemas/mail-messages';

/** The longest URL the link-check endpoint accepts. */
export const MAX_LINK_URL_LENGTH = 4096;
/** The longest visible anchor text put in the interstitial URL. */
export const MAX_LINK_TEXT_LENGTH = 200;
/** Path of the interstitial page (inside a workspace, like every WeldMail page). */
export const LINK_INTERSTITIAL_PATH = '/weldmail/link';

/** A parsed, validated http(s) URL. */
export function parseHttpUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LINK_URL_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The absolute http(s) URL an email anchor points at, or null for anything the
 * interstitial must not handle: `mailto:`, `tel:`, fragment-only and relative
 * hrefs, `javascript:` and every other scheme. A protocol-relative `//host`
 * resolves as https, like the browser would from an https page.
 */
export function absoluteHttpHref(rawHref: string | null): string | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  return parseHttpUrl(candidate)?.href ?? null;
}

/** Collapses whitespace and cuts the text to `MAX_LINK_TEXT_LENGTH`. */
export function normalizeLinkText(text: string | null | undefined): string {
  return (text ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, MAX_LINK_TEXT_LENGTH);
}

export interface InterstitialTarget {
  messageId: string;
  url: string;
  text: string;
}

/**
 * The interstitial URL for one link. `workspaceRef` carries the `/w/{ref}`
 * prefix of the current page, so the new tab opens in the same workspace.
 */
export function buildInterstitialUrl(
  origin: string,
  target: InterstitialTarget,
  workspaceRef?: string | null,
): string {
  const path = workspaceRef ? workspacePath(workspaceRef, LINK_INTERSTITIAL_PATH) : LINK_INTERSTITIAL_PATH;
  const fragment =
    `m=${encodeURIComponent(target.messageId)}` +
    `&u=${encodeURIComponent(target.url)}` +
    `&t=${encodeURIComponent(normalizeLinkText(target.text))}`;
  return `${origin}${path}#${fragment}`;
}

export type ParsedInterstitialFragment =
  | { ok: true; messageId: string; url: string; text: string; host: string }
  | { ok: false };

/**
 * Reads the interstitial's fragment. Only an http(s) URL with a message id
 * passes; anything else is `{ ok: false }` and the page never navigates.
 */
export function parseInterstitialFragment(hash: string): ParsedInterstitialFragment {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const messageId = params.get('m')?.trim();
  const rawUrl = params.get('u');
  if (!messageId || !rawUrl) return { ok: false };
  const url = parseHttpUrl(rawUrl);
  if (!url) return { ok: false };
  return {
    ok: true,
    messageId,
    url: url.href,
    text: normalizeLinkText(params.get('t')),
    host: url.host,
  };
}

export interface LinkProtectionContext {
  messageId: string;
  origin: string;
  workspaceRef?: string | null;
}

/**
 * Points an anchor at the interstitial when it links to an http(s) address.
 * `mailto:`, `tel:` and hrefs that are not absolute web addresses are left as
 * they are. Keeps `rel="noopener noreferrer"` and `target="_blank"`.
 */
export function protectAnchor(anchor: Element, context: LinkProtectionContext): boolean {
  const url = absoluteHttpHref(anchor.getAttribute('href'));
  if (!url) return false;
  anchor.setAttribute(
    'href',
    buildInterstitialUrl(
      context.origin,
      { messageId: context.messageId, url, text: anchor.textContent ?? '' },
      context.workspaceRef,
    ),
  );
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
  return true;
}

export type LinkDecision =
  /** Verified safe: forward the reader at once. */
  | { action: 'forward' }
  /** Suspicious: warn, with the reasons, and let the reader decide. */
  | { action: 'warn'; reasons: MailLinkCheckResult['reasons'] }
  /** Known-dangerous: block, with a small way through. */
  | { action: 'block'; reasons: MailLinkCheckResult['reasons'] }
  /** The check failed: fail open, but visibly. */
  | { action: 'unverified' };

/** What the interstitial does with a link-check answer (`null`: the request failed). */
export function decideLinkAction(result: MailLinkCheckResult | null): LinkDecision {
  if (!result) return { action: 'unverified' };
  switch (result.verdict) {
    case 'safe':
      return { action: 'forward' };
    case 'suspicious':
      return { action: 'warn', reasons: result.reasons };
    case 'malicious':
      return { action: 'block', reasons: result.reasons };
    default:
      return { action: 'unverified' };
  }
}

/** The `t.mail.linkProtection` key that explains one reason. */
export type LinkReasonKey =
  | 'reasonThreatFeedMalware'
  | 'reasonThreatFeedPhishing'
  | 'reasonThreatFeed'
  | 'reasonIpHost'
  | 'reasonUserinfo'
  | 'reasonHomograph';

export function linkReasonKey(reason: MailLinkCheckResult['reasons'][number]): LinkReasonKey {
  switch (reason.code) {
    case 'threat_feed':
      if (reason.threat === 'malware') return 'reasonThreatFeedMalware';
      if (reason.threat === 'phishing') return 'reasonThreatFeedPhishing';
      return 'reasonThreatFeed';
    case 'ip_host':
      return 'reasonIpHost';
    case 'userinfo':
      return 'reasonUserinfo';
    case 'homograph':
      return 'reasonHomograph';
  }
}
