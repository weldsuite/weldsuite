import type {
  BankFeedCompletePayload,
  BankFeedLinkKind,
  BankFeedLinkMode,
  BankFeedLinkSession,
} from '@/lib/api/domains/weldbooks-bank-feeds';

/**
 * What a launcher ends with. Every provider returns the same shape to the
 * connect flow, which posts `payload` to `POST /api/bank-connections/complete`.
 */
export type LaunchResult =
  /** The user finished linking: `payload` is what the provider's `completeLink` expects. */
  | { status: 'completed'; payload: BankFeedCompletePayload }
  /** The user closed the provider's window without linking. */
  | { status: 'cancelled' }
  /** The browser is leaving for the bank; the callback route finishes the link. */
  | { status: 'redirecting' };

export interface LaunchContext {
  provider: string;
  mode: BankFeedLinkMode;
  connectionId?: string;
  /** Exactly what was sent to `link-session` as `redirectUrl`. */
  redirectUrl: string;
  /** In-app path to return to once the link and the account mapping are done. */
  returnTo: string;
  /** Bank account the user started from: offered in the account mapping that follows a redirect. */
  defaultBankAccountId?: string;
  /** Leaves the page (`window.location.assign`); tests replace it. */
  navigate: (url: string) => void;
}

export type Launcher = (session: BankFeedLinkSession, context: LaunchContext) => Promise<LaunchResult>;

export type LauncherKind = BankFeedLinkKind;

export type LaunchErrorCode =
  /** The provider's script did not load (offline, blocked). */
  | 'script_failed'
  /** The link session came back without what the launcher needs. */
  | 'incomplete_session'
  /** The redirect URL is not https. */
  | 'insecure_url'
  /** No Stripe publishable key in this build. */
  | 'stripe_not_configured'
  /** The provider's own window reported an error. */
  | 'provider_error';

export class BankFeedLaunchError extends Error {
  readonly code: LaunchErrorCode;
  /** The provider's own wording; shown next to our message, never instead of it. */
  readonly detail: string | null;

  constructor(code: LaunchErrorCode, detail?: string | null) {
    super(`Bank feed launch failed: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'BankFeedLaunchError';
    this.code = code;
    this.detail = detail ?? null;
  }
}
