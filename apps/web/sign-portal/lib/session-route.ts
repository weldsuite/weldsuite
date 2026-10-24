import { NextRequest, NextResponse } from 'next/server';
import type { SignPortalSessionResponse } from '@weldsuite/app-api-client/schemas/weldsign';
import { portalUpstream, sessionCookieName, signerHeaders } from '@/lib/api';

/**
 * Server-only helpers for the `app/api/session|verify|resend-code` route
 * handlers. Not for client components.
 */

/** JSON headers plus the signer's IP and browser, which sign-api records on the evidence trail. */
export function upstreamHeaders(req: NextRequest): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...signerHeaders(req.headers.get('x-forwarded-for'), req.headers.get('user-agent')),
  };
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
