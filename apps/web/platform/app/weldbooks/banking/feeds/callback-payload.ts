import type { BankFeedCompletePayload } from '@/lib/api/domains/weldbooks-bank-feeds';
import type { FeedTexts, FormatText } from './feed-texts';
import type { PendingLink } from './launchers';

/** The complete-link payload a redirect provider needs, or the reason the return is unusable. */
export function redirectPayload(
  pending: Pick<PendingLink, 'state' | 'redirectUrl'>,
  params: URLSearchParams,
  t: FeedTexts,
  format: FormatText,
): { payload: BankFeedCompletePayload } | { error: string } {
  const denied = params.get('error');
  if (denied) {
    const reason = params.get('error_description') || denied;
    return { error: format(t.callback.errors.deniedWithReason, { reason }) };
  }
  const code = params.get('code');
  if (!code) return { error: t.callback.errors.missingCode };

  const state = params.get('state');
  // The bank echoes the state it was sent: a different one is not our return.
  if (pending.state && state !== pending.state) return { error: t.callback.errors.stateMismatch };

  return { payload: { code, ...(state ? { state } : {}), redirectUrl: pending.redirectUrl } };
}
