/**
 * What a failed bank feed call says to the user: our own sentence for what
 * went wrong, plus the provider's wording when it sent one (books-api only
 * forwards provider messages that carry no credentials).
 */
import { isBankFeedRequestError } from '@/lib/api/domains/weldbooks-bank-feeds';
import { BankFeedLaunchError } from './launchers';
import type { FeedTexts, FormatText } from './feed-texts';

export type FeedOperation =
  /** Starting, launching or completing a link. */
  | 'link'
  /** Mapping accounts to bank accounts. */
  | 'map'
  | 'other';

export interface FeedErrorMessage {
  message: string;
  /** The provider's or server's wording, to show next to `message`. */
  detail: string | null;
}

function withDetail(message: string, detail: string | null | undefined): FeedErrorMessage {
  return { message, detail: detail?.trim() || null };
}

export function describeFeedError(
  err: unknown,
  t: FeedTexts,
  operation: FeedOperation = 'other',
): FeedErrorMessage {
  const texts = t.errors;

  if (err instanceof BankFeedLaunchError) {
    switch (err.code) {
      case 'script_failed':
        return withDetail(texts.scriptFailed, null);
      case 'incomplete_session':
        return withDetail(texts.incompleteSession, null);
      case 'insecure_url':
        return withDetail(texts.insecureUrl, null);
      case 'stripe_not_configured':
        return withDetail(texts.stripeNotConfigured, null);
      case 'provider_error':
        return withDetail(texts.providerWindow, err.detail);
    }
  }

  if (isBankFeedRequestError(err)) {
    switch (err.status) {
      case 400:
        return withDetail(texts.badRequest, err.message);
      case 403:
        return withDetail(texts.forbidden, null);
      case 404:
        return withDetail(texts.notFound, null);
      case 409:
        return withDetail(operation === 'map' ? texts.conflictMap : texts.conflictLink, null);
      case 502:
        return withDetail(texts.providerFailed, err.message);
      case 503:
        return withDetail(texts.unavailable, null);
      default:
        return withDetail(texts.generic, null);
    }
  }

  return withDetail(texts.generic, null);
}

/** One line for a toast: the message, then the provider's wording when there is one. */
export function feedErrorText(error: FeedErrorMessage, t: FeedTexts, format: FormatText): string {
  return error.detail ? `${error.message} ${format(t.errors.detail, { detail: error.detail })}` : error.message;
}
