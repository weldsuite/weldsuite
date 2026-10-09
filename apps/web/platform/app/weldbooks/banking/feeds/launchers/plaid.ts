/**
 * Plaid Link launcher. Plaid's script is loaded on first use (never on page
 * load), Link opens over the page, and `onSuccess` hands back a one-time
 * `public_token` that books-api exchanges for the access token. The access
 * token never reaches the browser.
 *
 * OAuth banks leave the page: Plaid sends the browser back to the callback
 * route with `oauth_state_id`, and Link is re-opened there with
 * `receivedRedirectUri` (`resumePlaidOAuth`).
 */
import type { BankFeedCompletePayload, BankFeedLinkMode } from '@/lib/api/domains/weldbooks-bank-feeds';
import { clearPendingLink, savePendingLink } from './pending-link';
import { BankFeedLaunchError, type LaunchResult, type Launcher } from './types';

export const PLAID_SCRIPT_URL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidSuccessMetadata {
  institution?: { institution_id?: string | null; name?: string | null } | null;
}

interface PlaidLinkError {
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

interface PlaidLinkHandler {
  open(): void;
  exit(options?: { force?: boolean }): void;
  destroy(): void;
}

interface PlaidLinkOptions {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, metadata: PlaidSuccessMetadata) => void;
  onExit: (error: PlaidLinkError | null, metadata: unknown) => void;
}

interface PlaidGlobal {
  create(options: PlaidLinkOptions): PlaidLinkHandler;
}

function currentPlaid(): PlaidGlobal | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
}

let scriptPromise: Promise<PlaidGlobal> | null = null;

/** Loads Plaid's script once; a failed load can be retried. */
export function loadPlaid(): Promise<PlaidGlobal> {
  const existing = currentPlaid();
  if (existing) return Promise.resolve(existing);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<PlaidGlobal>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PLAID_SCRIPT_URL;
    script.async = true;
    const fail = () => {
      script.remove();
      scriptPromise = null;
      reject(new BankFeedLaunchError('script_failed'));
    };
    script.onload = () => {
      const plaid = currentPlaid();
      if (plaid) resolve(plaid);
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Test seam: forget the cached script load. */
export function resetPlaidLoaderForTests(): void {
  scriptPromise = null;
}

/** Update mode (`reauth`, `add_accounts`) has no `public_token` to exchange: the stored access token is reused. */
export function plaidPayload(
  mode: BankFeedLinkMode,
  publicToken: string,
  metadata: PlaidSuccessMetadata,
): BankFeedCompletePayload {
  if (mode !== 'create') return {};
  const institution = metadata.institution;
  const institutionId = institution?.institution_id || undefined;
  const name = institution?.name || undefined;
  return {
    publicToken,
    ...(institutionId || name ? { institution: { ...(institutionId ? { institutionId } : {}), ...(name ? { name } : {}) } } : {}),
  };
}

function openLink(token: string, mode: BankFeedLinkMode, receivedRedirectUri?: string): Promise<LaunchResult> {
  return loadPlaid().then(
    (plaid) =>
      new Promise<LaunchResult>((resolve, reject) => {
        const handler = plaid.create({
          token,
          receivedRedirectUri,
          onSuccess: (publicToken, metadata) => {
            clearPendingLink();
            handler.destroy();
            resolve({ status: 'completed', payload: plaidPayload(mode, publicToken, metadata) });
          },
          onExit: (error) => {
            clearPendingLink();
            handler.destroy();
            if (error) {
              reject(new BankFeedLaunchError('provider_error', error.display_message ?? error.error_message ?? null));
            } else {
              resolve({ status: 'cancelled' });
            }
          },
        });
        handler.open();
      }),
  );
}

export const launchPlaid: Launcher = async (session, context) => {
  if (!session.token) throw new BankFeedLaunchError('incomplete_session');
  // An OAuth bank takes the page away: leave what the callback route needs to pick the link back up.
  savePendingLink({
    provider: context.provider,
    kind: 'plaid_link',
    mode: context.mode,
    connectionId: context.connectionId,
    redirectUrl: context.redirectUrl,
    returnTo: context.returnTo,
    defaultBankAccountId: context.defaultBankAccountId,
    linkToken: session.token,
  });
  return openLink(session.token, context.mode);
};

/** Re-open Link after an OAuth bank returned to the callback route. */
export function resumePlaidOAuth(args: {
  linkToken: string;
  mode: BankFeedLinkMode;
  receivedRedirectUri: string;
}): Promise<LaunchResult> {
  return openLink(args.linkToken, args.mode, args.receivedRedirectUri);
}
