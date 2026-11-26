/**
 * Sign-in through the system browser on the OIDC editions (EU and
 * self-hosted, on WeldID or Zitadel): RFC 8252's loopback redirect.
 *
 * Google and Microsoft refuse sign-in inside an embedded window, and the
 * provider's session cookie belongs in the person's browser anyway, so the
 * authorization request opens there and comes back to a one-shot HTTP
 * listener on 127.0.0.1 with a random port. The page in the app view builds
 * the request (oidc-client-ts: state, nonce, PKCE S256) and redeems the code
 * itself, so the PKCE verifier and the tokens never leave it; this side only
 * opens the browser and hands back the callback URL whose `state` matches
 * (docs/auth-handoff.md, "OIDC editions").
 *
 * Rules the listener keeps:
 * - bound to 127.0.0.1 only (never `localhost`, which may resolve to another
 *   interface, never 0.0.0.0), on a port the OS picks;
 * - one answer: the first GET of `/callback` with this sign-in's `state` and
 *   this listener's `Host` closes it; anything else is refused and the
 *   listener keeps waiting, so a stray request can't end a real sign-in;
 * - gone after SIGN_IN_TIMEOUT_MS or a cancel;
 * - the page it answers with loads nothing (`default-src 'none'`).
 *
 * Nothing here logs a URL: the callback carries the authorization code.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** RFC 8252 section 8.3: the IP literal, not `localhost`. */
export const LOOPBACK_HOST = '127.0.0.1';
/** The path registered at the provider (`http://127.0.0.1/callback`, any port). */
export const CALLBACK_PATH = '/callback';
/**
 * How long one sign-in may take, from opening the listener: room for a
 * password reset or a second factor in the browser.
 */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** What the app page learns from one sign-in. */
export type LoopbackOutcome =
  /** The browser came back with this sign-in's `state`: a code, or the provider's error. */
  | { status: 'callback'; callbackUrl: string }
  | { status: 'cancelled' }
  | { status: 'timeout' }
  | { status: 'failed'; reason: LoopbackFailure };

export type LoopbackFailure =
  /** The authorization request isn't one this listener can answer. */
  | 'invalid_request'
  /** No such sign-in (another one replaced it, or it ended). */
  | 'unknown_sign_in'
  /** The system browser didn't open. */
  | 'browser'
  /** The listener failed. */
  | 'listener';

/** The page the browser shows once it is back, in the app's language. */
export interface CallbackPageText {
  lang: string;
  successTitle: string;
  successBody: string;
  failureTitle: string;
  failureBody: string;
}

export const DEFAULT_PAGE_TEXT: CallbackPageText = {
  lang: 'en',
  successTitle: "You're signed in",
  successBody: 'You can close this tab and go back to the WeldSuite app.',
  failureTitle: "Signing in didn't complete",
  failureBody: 'Close this tab and try again in the WeldSuite app.',
};

const MAX_TEXT_LENGTH = 300;

/** The page text the app sent, field by field; anything unusable falls back to English. */
export function readPageText(value: unknown): CallbackPageText {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (key: Exclude<keyof CallbackPageText, 'lang'>) => {
    const candidate = input[key];
    return typeof candidate === 'string' && candidate.trim() && candidate.length <= MAX_TEXT_LENGTH
      ? candidate
      : DEFAULT_PAGE_TEXT[key];
  };
  const lang = typeof input.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(input.lang) ? input.lang : 'en';
  return {
    lang,
    successTitle: text('successTitle'),
    successBody: text('successBody'),
    failureTitle: text('failureTitle'),
    failureBody: text('failureBody'),
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The origin of the OIDC issuer the app's `/config.json` names
 * (`auth.issuer`): https, or http on a loopback host for local development.
 * Null for a Clerk edition or anything malformed. The main process reads it
 * itself, so the page can't choose where the browser is sent.
 */
export function issuerFromRuntimeConfig(config: unknown): string | null {
  const auth = (config as { auth?: { provider?: unknown; issuer?: unknown } } | null)?.auth;
  if (auth?.provider !== 'oidc' || typeof auth.issuer !== 'string') return null;
  let issuer: URL;
  try {
    issuer = new URL(auth.issuer);
  } catch {
    return null;
  }
  const transport = issuer.protocol === 'https:' || (issuer.protocol === 'http:' && isLoopbackHostname(issuer.hostname));
  return transport && !issuer.username && !issuer.password ? issuer.origin : null;
}

/**
 * The authorization request the app page wants opened, checked before it
 * reaches the browser: an endpoint on the issuer's origin (from
 * `issuerFromRuntimeConfig`), the code flow with PKCE S256, a `state`, and
 * this listener as its redirect. Null when it is anything else.
 *
 * `url` is what to open: rebuilt on the issuer's origin, so nothing the page
 * sends can change the host. WeldID, Zitadel and the common providers serve
 * their authorization endpoint on the issuer's origin.
 */
export function checkAuthorizationRequest(
  rawUrl: string,
  redirectUri: string,
  issuerOrigin: string,
): { state: string; url: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== issuerOrigin || url.username || url.password) return null;
  const params = url.searchParams;
  const state = params.get('state');
  if (
    params.get('redirect_uri') !== redirectUri ||
    params.get('response_type') !== 'code' ||
    params.get('code_challenge_method') !== 'S256' ||
    !params.get('code_challenge') ||
    !params.get('client_id') ||
    !state ||
    state.length > 512
  ) {
    return null;
  }
  return { state, url: `${issuerOrigin}${url.pathname}${url.search}` };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The page the browser shows on its way back: inline styles only, no script,
 * image, font or link, so it loads nothing from anywhere
 * (`CALLBACK_PAGE_HEADERS` tells the browser so too).
 */
export function callbackPage(text: CallbackPageText, succeeded: boolean): string {
  const title = escapeHtml(succeeded ? text.successTitle : text.failureTitle);
  const body = escapeHtml(succeeded ? text.successBody : text.failureBody);
  const mark = succeeded ? '&#10003;' : '!';
  const tone = succeeded ? '#15803d' : '#b91c1c';
  return `<!doctype html>
<html lang="${escapeHtml(text.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#111827;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;padding:32px 24px;text-align:center}
.mark{width:48px;height:48px;margin:0 auto 20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;color:${tone};background:${tone}1a}
h1{margin:0 0 8px;font-size:22px;font-weight:600}
p{margin:0;color:#4b5563}
</style>
</head>
<body>
<main>
<div class="mark" aria-hidden="true">${mark}</div>
<h1>${title}</h1>
<p>${body}</p>
</main>
</body>
</html>
`;
}

/** Sent with the callback page: it may load nothing, be framed by nothing, and is never cached. */
export const CALLBACK_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  Connection: 'close',
};

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(message);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One sign-in's listener. */
export class LoopbackSignIn {
  /** Names this sign-in to the app page, so a stale page can't drive a newer one. */
  readonly id = randomUUID();
  /** `http://127.0.0.1:<port>/callback`. */
  readonly redirectUri: string;
  /** Resolves once, with how the sign-in ended. */
  readonly outcome: Promise<LoopbackOutcome>;

  private readonly server: Server;
  private readonly host: string;
  private readonly timer: ReturnType<typeof setTimeout>;
  private resolveOutcome!: (outcome: LoopbackOutcome) => void;
  private expected: { state: string; page: CallbackPageText } | null = null;
  private answered = false;
  private settled = false;

  private constructor(server: Server, port: number, timeoutMs: number) {
    this.server = server;
    this.host = `${LOOPBACK_HOST}:${port}`;
    this.redirectUri = `http://${this.host}${CALLBACK_PATH}`;
    this.outcome = new Promise((resolve) => {
      this.resolveOutcome = resolve;
    });
    server.on('request', (req, res) => this.handle(req, res));
    server.on('error', () => this.finish({ status: 'failed', reason: 'listener' }));
    this.timer = setTimeout(() => this.finish({ status: 'timeout' }), timeoutMs);
    this.timer.unref?.();
  }

  /** Listen on 127.0.0.1, on a port the OS picks. */
  static open(options: { timeoutMs?: number } = {}): Promise<LoopbackSignIn> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
        server.off('error', reject);
        const { port } = server.address() as AddressInfo;
        resolve(new LoopbackSignIn(server, port, options.timeoutMs ?? SIGN_IN_TIMEOUT_MS));
      });
    });
  }

  /** Where the listener is bound. */
  address(): AddressInfo | null {
    const address = this.server.address();
    return address && typeof address === 'object' ? address : null;
  }

  /** Whether the authorization request has gone to the browser. */
  get expecting(): boolean {
    return this.expected !== null;
  }

  /**
   * Accept the browser's return for `state`, the authorization request's.
   * Resolves like `outcome`.
   */
  expect(state: string, page: CallbackPageText = DEFAULT_PAGE_TEXT): Promise<LoopbackOutcome> {
    if (!this.settled) this.expected = { state, page };
    return this.outcome;
  }

  cancel(): void {
    this.finish({ status: 'cancelled' });
  }

  fail(reason: LoopbackFailure): void {
    this.finish({ status: 'failed', reason });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.answered || this.settled) {
      refuse(res, 404, 'Not found');
      return;
    }
    if (req.method !== 'GET') {
      refuse(res, 405, 'Method not allowed');
      return;
    }
    // A page that points a name of its own at 127.0.0.1 sends that name.
    if (req.headers.host !== this.host) {
      refuse(res, 400, 'Bad request');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${this.host}`);
    if (url.pathname !== CALLBACK_PATH) {
      refuse(res, 404, 'Not found');
      return;
    }
    const expected = this.expected;
    const state = url.searchParams.get('state');
    if (!expected || !state || !sameText(state, expected.state)) {
      refuse(res, 400, 'This is not the sign-in the WeldSuite app is waiting for.');
      return;
    }
    this.answered = true;
    const succeeded = url.searchParams.has('code') && !url.searchParams.has('error');
    const callbackUrl = url.href;
    res.once('close', () => this.finish({ status: 'callback', callbackUrl }));
    res.writeHead(200, CALLBACK_PAGE_HEADERS);
    res.end(callbackPage(expected.page, succeeded));
  }

  private finish(outcome: LoopbackOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.expected = null;
    clearTimeout(this.timer);
    this.server.close();
    this.server.closeAllConnections();
    this.resolveOutcome(outcome);
  }
}
