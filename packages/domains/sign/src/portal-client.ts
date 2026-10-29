/**
 * The signer operations over HTTP (ADR FE-017): on Kubernetes the sign portal
 * runs as a Node container and calls the Rust backend's
 * `/public/sign-portal/*` endpoints instead of running `createSignPortal()`
 * (./portal.ts) itself, which needs the Cloudflare bindings Global has.
 *
 * Same operations, same answers: each method returns the backend's
 * `Response` (`{ data }`, or `{ error: { code, message, details? } }` with its
 * status, or the PDF), so the portal's routes pass it on exactly as they pass
 * on the domain's.
 *
 *   POST /session      { token }         POST /consent   { disclosureVersion }
 *   POST /verify       { token, code }   POST /complete  { values, signature, … }
 *   POST /resend-code  { token }         POST /decline   { reason }
 *   GET  /envelope                       GET  /download
 *   GET  /documents/:documentId
 *
 * The signer session travels as `Authorization: Bearer <session>`. The
 * signer's IP and browser, for the evidence trail, travel as `X-Signer-Ip`
 * and `User-Agent` next to the shared `SIGN_PORTAL_SECRET` in
 * `X-Sign-Portal-Key`: the backend trusts the reported IP only with the key,
 * as sign-api did before FE-016.
 *
 * Imports nothing at run time but `fetch`, so the portal's Node build carries
 * no Workers code.
 */

import type { SignerMeta } from './signing';

/** Header carrying the shared portal secret. */
export const SIGN_PORTAL_KEY_HEADER = 'x-sign-portal-key';
/** Header carrying the signer's IP; trusted only next to the key. */
export const SIGNER_IP_HEADER = 'x-signer-ip';
/** Where the backend serves the signer operations. */
export const SIGN_PORTAL_PATH = '/public/sign-portal';

export interface SignPortalClientOptions {
  /** The backend's origin, e.g. `http://weldsuite` inside the cluster. */
  url: string;
  /** `SIGN_PORTAL_SECRET`, the same value the backend has. */
  secret: string;
  fetch?: typeof fetch;
}

/** The headers of the backend's answer that reach the signer. */
const PASSED_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options'];

const unavailable = () =>
  Response.json(
    { error: { code: 'SERVICE_UNAVAILABLE', message: 'Signing is unavailable. Try again in a moment.' } },
    { status: 503 },
  );

export type SignPortalClient = ReturnType<typeof createSignPortalClient>;

export function createSignPortalClient(options: SignPortalClientOptions) {
  let origin = options.url;
  while (origin.endsWith('/')) origin = origin.slice(0, -1);
  const base = `${origin}${SIGN_PORTAL_PATH}`;
  const fetchImpl = options.fetch ?? fetch;

  async function call(
    meta: SignerMeta,
    method: 'GET' | 'POST',
    path: string,
    { session, body }: { session?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers({ accept: 'application/json', [SIGN_PORTAL_KEY_HEADER]: options.secret });
    if (meta.ip) headers.set(SIGNER_IP_HEADER, meta.ip);
    if (meta.userAgent) headers.set('user-agent', meta.userAgent);
    if (session) headers.set('authorization', `Bearer ${session}`);
    const init: RequestInit = { method, headers, redirect: 'manual' };
    if (method === 'POST') {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body ?? null);
    }
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, init);
    } catch (err) {
      console.error(`[sign-portal] the backend did not answer ${method} ${path}:`, err);
      return unavailable();
    }
    const out = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = res.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(res.body, { status: res.status, headers: out });
  }

  return {
    openSession: (meta: SignerMeta, input: unknown) => call(meta, 'POST', '/session', { body: input }),
    verify: (meta: SignerMeta, input: unknown) => call(meta, 'POST', '/verify', { body: input }),
    resendCode: (meta: SignerMeta, input: unknown) => call(meta, 'POST', '/resend-code', { body: input }),
    envelope: (meta: SignerMeta, session: string | undefined) => call(meta, 'GET', '/envelope', { session }),
    document: (meta: SignerMeta, session: string | undefined, documentId: string) =>
      call(meta, 'GET', `/documents/${encodeURIComponent(documentId)}`, { session }),
    consent: (meta: SignerMeta, session: string | undefined, input: unknown) =>
      call(meta, 'POST', '/consent', { session, body: input }),
    complete: (meta: SignerMeta, session: string | undefined, input: unknown) =>
      call(meta, 'POST', '/complete', { session, body: input }),
    decline: (meta: SignerMeta, session: string | undefined, input: unknown) =>
      call(meta, 'POST', '/decline', { session, body: input }),
    download: (meta: SignerMeta, session: string | undefined) => call(meta, 'GET', '/download', { session }),
  };
}

/**
 * The portal's backend setting, from its environment:
 *
 * - `SIGN_PORTAL_BACKEND` unset or `domain`: run the domain code itself
 *   (Global, FE-016). Returns null.
 * - `rust`: call the backend at `SIGN_PORTAL_BACKEND_URL` with
 *   `SIGN_PORTAL_SECRET` (Kubernetes, FE-017). Both are required.
 *
 * Throws on anything else, so a half-configured portal fails at its first
 * request instead of signing with the wrong setup.
 */
export function signPortalClientFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): SignPortalClient | null {
  const backend = env.SIGN_PORTAL_BACKEND?.trim() || 'domain';
  if (backend === 'domain') return null;
  if (backend !== 'rust') throw new Error(`SIGN_PORTAL_BACKEND must be rust or domain, not ${backend}`);
  const url = env.SIGN_PORTAL_BACKEND_URL?.trim();
  const secret = env.SIGN_PORTAL_SECRET?.trim();
  if (!url || !/^https?:\/\//.test(url)) throw new Error('SIGN_PORTAL_BACKEND=rust needs SIGN_PORTAL_BACKEND_URL (http:// or https://)');
  if (!secret) throw new Error('SIGN_PORTAL_BACKEND=rust needs SIGN_PORTAL_SECRET');
  return createSignPortalClient({ url, secret, fetch: fetchImpl });
}

/**
 * The client's address from `X-Forwarded-For` behind `trustedProxies`
 * proxies that each append the address they saw (the ingress controller:
 * 1). Counted from the right, so a value the client sent itself is never
 * taken. Null when the header has fewer entries or the entry is no address.
 */
export function forwardedClientIp(forwardedFor: string | null | undefined, trustedProxies = 1): string | null {
  if (!forwardedFor || trustedProxies < 1) return null;
  const hops = forwardedFor
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  const ip = hops[hops.length - trustedProxies];
  return ip && /^[0-9A-Fa-f.:]{2,45}$/.test(ip) ? ip : null;
}
