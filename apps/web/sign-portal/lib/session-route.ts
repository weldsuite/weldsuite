import { NextRequest, NextResponse } from 'next/server';
import type { SignPortalSessionResponse } from '@weldsuite/app-api-client/schemas/weldsign';
import { portalUpstream, sessionCookieName } from '@/lib/api';

/**
 * Server-only helpers for the `app/api/session|verify|resend-code` route
 * handlers. Not for client components.
 */

/** JSON headers plus the signer's IP and browser, which sign-api records on the evidence trail. */
export function upstreamHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;
  const clientIp = forwardedFor?.split(',')[0]?.trim();
  if (clientIp) headers['X-Signer-Ip'] = clientIp;
  const userAgent = req.headers.get('user-agent');
  if (userAgent) headers['User-Agent'] = userAgent;
  return headers;
}

type UpstreamBody = { data?: SignPortalSessionResponse } & Record<string, unknown>;

/**
 * Forwards `{ token, code? }` to a session-issuing upstream route. When the
 * answer is `ready`, the session string goes into an httpOnly cookie and is
 * removed from the JSON, so it never reaches browser JavaScript.
 */
export async function forwardSessionRequest(req: NextRequest, path: '/session' | '/verify'): Promise<NextResponse> {
  const input = (await req.json().catch(() => ({}))) as { token?: unknown; code?: unknown };
  const token = String(input.token ?? '');
  const payload: Record<string, string> = { token };
  if (path === '/verify') payload.code = String(input.code ?? '');

  const res = await fetch(portalUpstream(path), {
    method: 'POST',
    headers: upstreamHeaders(req),
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as UpstreamBody;

  const data = json.data;
  if (res.ok && data && data.state === 'ready') {
    const { session, expiresAt, ...rest } = data;
    const out = NextResponse.json({ data: { ...rest, expiresAt } }, { status: res.status });
    const expires = new Date(expiresAt);
    out.cookies.set(sessionCookieName(token), session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      ...(Number.isNaN(expires.getTime()) ? {} : { expires }),
    });
    return out;
  }
  return NextResponse.json(json, { status: res.status });
}
