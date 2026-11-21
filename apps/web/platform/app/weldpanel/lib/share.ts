/** Share links: the embed code, the API's refusal, and a link's state. */

import { isApiError } from '@weldsuite/api-client';
import type { PanelNotShareableDetails, PanelShareLinkDto, PanelShareRefusal } from '@weldsuite/app-api-client/schemas/weldpanel-collab';

/** The link with `?embed=1`: the page without its header and footer. */
export function embedUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}embed=1`;
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** An iframe to paste into another site. */
export function iframeSnippet(url: string, title: string): string {
  return `<iframe src="${escapeAttr(embedUrl(url))}" title="${escapeAttr(title)}" width="100%" height="600" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
}

const REFUSALS: readonly PanelShareRefusal[] = ['kind', 'person_breakdown', 'column_breakdown'];

/**
 * Why the API refused to share (`422 NOT_SHAREABLE`, `details.reasons`), or
 * null when the error is something else.
 */
export function shareRefusals(error: unknown): PanelNotShareableDetails['reasons'] | null {
  if (!isApiError(error) || error.status !== 422) return null;
  const body = error.body as { error?: { code?: string; details?: Partial<PanelNotShareableDetails> } } | undefined;
  if (body?.error?.code !== 'NOT_SHAREABLE') return null;
  const reasons = Array.isArray(body.error.details?.reasons) ? body.error.details.reasons : [];
  return reasons.filter((r) => typeof r?.reportId === 'string' && REFUSALS.includes(r.reason));
}

export type ShareLinkState = 'active' | 'expired' | 'revoked';

export function shareLinkState(link: Pick<PanelShareLinkDto, 'revokedAt' | 'expiresAt'>, now: number = Date.now()): ShareLinkState {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && Date.parse(link.expiresAt) <= now) return 'expired';
  return 'active';
}
