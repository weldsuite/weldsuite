/**
 * Signing in through the system browser (RFC 8252): the desktop shell on an
 * OIDC edition. Google and Microsoft refuse sign-in inside an embedded
 * window, so the shell opens the provider in the person's browser and takes
 * the answer on a one-shot listener on 127.0.0.1 (apps/desktop,
 * `docs/auth-handoff.md`, "OIDC editions").
 *
 * The split: this page builds the authorization request (state, nonce, PKCE
 * S256, in `oidc-client-ts`'s own state store) and redeems the code at the
 * token endpoint itself, so the PKCE verifier and the tokens never leave it
 * and are stored exactly where a browser sign-in stores them. The shell only
 * listens, opens the browser and hands back the callback URL whose `state`
 * matches. `session.ts` drives it; `lib/desktop-auth.ts` adapts the shell's
 * bridge to [`BrowserSignIn`].
 *
 * No imports: the facade re-exports [`BrowserSignInError`] to every screen.
 */

/** The shell's part of a sign-in. */
export interface BrowserSignIn {
  /** Open a one-shot listener; its `redirectUri` goes into the authorization request. */
  start(): Promise<{ id: string; redirectUri: string }>;
  /**
   * Open the authorization request in the system browser and wait for it to
   * come back; resolves to the callback URL. Rejects with
   * [`BrowserSignInError`].
   */
  authorize(id: string, url: string): Promise<string>;
  /** Stop waiting (`authorize` then rejects as cancelled). */
  cancel(id: string): Promise<void>;
  /** Open a URL in the system browser: the provider's sign-out, where its session cookie lives. */
  openExternal(url: string): Promise<void>;
}

/** Why a sign-in through the browser ended without a session. */
export type BrowserSignInFailure =
  /** The person cancelled, or left the screen. */
  | 'cancelled'
  /** The browser never came back. */
  | 'timeout'
  /** Anything else: the shell refused, the provider refused, the code didn't redeem. */
  | 'failed';

export class BrowserSignInError extends Error {
  readonly reason: BrowserSignInFailure;

  constructor(reason: BrowserSignInFailure) {
    super(`Signing in through the browser ended: ${reason}`);
    this.name = 'BrowserSignInError';
    this.reason = reason;
  }
}
