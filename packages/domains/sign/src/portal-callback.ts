/**
 * The signer's round trip to a trust service provider (eIDAS advanced and
 * qualified signatures), seen from the sign portal's server:
 *
 *   1. `POST /api/portal/signature/start` answers with the provider's
 *      `redirectUrl` and a `state`. The portal remembers which signing link and
 *      which `state` the round trip belongs to in a short-lived httpOnly cookie,
 *      because the provider only redirects to one fixed, registered URL,
 *      `<portal origin>/signature-callback?code=…&state=…`, without the link token.
 *   2. The provider sends the browser back there. `handleSignatureCallback`
 *      checks the `state` against the cookie, calls the backend's
 *      `signature/finish` with that link's session, and answers where the
 *      browser goes next: another provider round trip (the certificate is only
 *      known after the signer identifies, so the hash to authorise can need a
 *      second redirect), or the link's page.
 *
 * Pure functions over strings and injected calls, so it runs in the Worker
 * and the Node build alike and is tested without either.
 */

/** Cookie that remembers a round trip in progress. */
export const PENDING_COOKIE = 'signportal_pending';
/** How long a signer has to come back: the provider's own sessions are shorter. */
export const PENDING_MAX_AGE_SECONDS = 30 * 60;
/** Where the provider redirects the browser. */
export const SIGNATURE_CALLBACK_PATH = '/signature-callback';

export interface PendingSignature {
  /** The signing link's token (`/r/<token>`). */
  token: string;
  state: string;
}

/** Why the signer lands on the link's page without having signed. */
export type SignatureReturn = 'failed' | 'cancelled';

const attributes = (secure: boolean, maxAge: number) =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

/** `Set-Cookie` value that stores the round trip, replacing an earlier one. */
export function pendingCookie(pending: PendingSignature, secure: boolean): string {
  return `${PENDING_COOKIE}=${encodeURIComponent(JSON.stringify(pending))}; ${attributes(secure, PENDING_MAX_AGE_SECONDS)}`;
}

/** `Set-Cookie` value that removes it. */
export function clearedPendingCookie(secure: boolean): string {
  return `${PENDING_COOKIE}=; ${attributes(secure, 0)}`;
}

/** The round trip the browser's `Cookie` header remembers, or null. */
export function readPendingCookie(cookieHeader: string | null | undefined): PendingSignature | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== PENDING_COOKIE) continue;
    try {
      const value = JSON.parse(decodeURIComponent(rest.join('='))) as Partial<PendingSignature>;
      if (typeof value.token === 'string' && value.token && typeof value.state === 'string' && value.state) {
        return { token: value.token, state: value.state };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Only http(s) addresses are followed: the backend's answer is not trusted to hold a script URL. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** The pieces of a `signature/start` or `signature/finish` answer that mean "go to the provider". */
export async function redirectOf(res: Response): Promise<{ redirectUrl: string; state: string | null } | null> {
  if (!res.ok) return null;
  const json = (await res
    .clone()
    .json()
    .catch(() => null)) as { data?: { redirectUrl?: unknown; state?: unknown } } | null;
  const redirectUrl = json?.data?.redirectUrl;
  if (!isHttpUrl(redirectUrl)) return null;
  const state = json?.data?.state;
  return { redirectUrl, state: typeof state === 'string' && state ? state : null };
}

export interface SignatureCallbackDeps {
  /** The signer session of a link (its httpOnly cookie), if the browser still has one. */
  sessionFor: (token: string) => Promise<string | undefined> | string | undefined;
  finish: (session: string | undefined, input: Record<string, string>) => Promise<Response>;
  cancel: (session: string | undefined, input: Record<string, string>) => Promise<Response>;
}

export interface SignatureCallbackResult {
  /** Where to redirect the browser (relative to the portal, or the provider's address). */
  location: string;
  /** The `Set-Cookie` to send with the redirect. */
  setCookie: string;
}

const linkPage = (token: string, back?: SignatureReturn) =>
  `/r/${encodeURIComponent(token)}${back ? `?signature=${back}` : ''}`;

/**
 * What to do with the provider's redirect back to `/signature-callback`.
 * Never throws: a failed call sends the signer back to their link, where they
 * can try again or decline.
 */
export async function handleSignatureCallback(
  url: URL,
  cookieHeader: string | null | undefined,
  deps: SignatureCallbackDeps,
): Promise<SignatureCallbackResult> {
  const secure = url.protocol === 'https:';
  const cleared = clearedPendingCookie(secure);
  const pending = readPendingCookie(cookieHeader);
  const state = url.searchParams.get('state');
  // A callback this browser did not start (or a stale one) has nothing to finish.
  if (!pending || !state || state !== pending.state) return { location: '/', setCookie: cleared };

  const code = url.searchParams.get('code') ?? undefined;
  const error = url.searchParams.get('error') ?? undefined;
  const errorDescription = url.searchParams.get('error_description') ?? undefined;

  try {
    const session = await deps.sessionFor(pending.token);
    if (error === 'access_denied') {
      // The signer said no at the provider.
      await deps.cancel(session, { state });
      return { location: linkPage(pending.token, 'cancelled'), setCookie: cleared };
    }
    if (!code && !error) return { location: linkPage(pending.token, 'failed'), setCookie: cleared };

    const input: Record<string, string> = { state };
    if (code) input.code = code;
    if (error) input.error = error;
    if (errorDescription) input.errorDescription = errorDescription;
    const res = await deps.finish(session, input);

    const next = await redirectOf(res);
    if (next) {
      // A second round trip: the same link, a new state.
      return {
        location: next.redirectUrl,
        setCookie: pendingCookie({ token: pending.token, state: next.state ?? pending.state }, secure),
      };
    }
    return { location: linkPage(pending.token, res.ok ? undefined : 'failed'), setCookie: cleared };
  } catch {
    return { location: linkPage(pending.token, 'failed'), setCookie: cleared };
  }
}
