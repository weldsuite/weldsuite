import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { SIGN_LINK_HEADER, portalUpstream, sessionCookieName } from '@/lib/api';

/**
 * Generic authenticated proxy: browser code calls `/api/portal/<path>` on this
 * origin, which forwards to `/public/sign-portal/<path>` with the signer
 * session from the httpOnly cookie as a bearer token. The token never reaches
 * browser JavaScript.
 */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const link = req.headers.get(SIGN_LINK_HEADER);
  const token = link ? (await cookies()).get(sessionCookieName(link))?.value : undefined;
  const dest = new URL(portalUpstream(`/${path.join('/')}`));
  req.nextUrl.searchParams.forEach((value, key) => dest.searchParams.set(key, value));

  const headers: Record<string, string> = {
    Accept: req.headers.get('Accept') || 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const contentType = req.headers.get('Content-Type');
  if (contentType) headers['Content-Type'] = contentType;
  // sign-api records the signer's IP and browser on the evidence trail.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    headers['X-Forwarded-For'] = forwardedFor;
    // The first entry is the client; sign-api stores it as the signer's IP.
    const clientIp = forwardedFor.split(',')[0]?.trim();
    if (clientIp) headers['X-Signer-Ip'] = clientIp;
  }
  const userAgent = req.headers.get('user-agent');
  if (userAgent) headers['User-Agent'] = userAgent;

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Raw bytes, not text: signature images are binary.
    init.body = await req.arrayBuffer();
  }

  const res = await fetch(dest.toString(), init);
  const body = await res.arrayBuffer();
  const outHeaders = new Headers();
  for (const name of ['content-type', 'content-disposition']) {
    const v = res.headers.get(name);
    if (v) outHeaders.set(name, v);
  }
  // Signed documents and envelopes are private; never let a cache keep them.
  outHeaders.set('cache-control', 'private, no-store');
  return new NextResponse(body, { status: res.status, headers: outHeaders });
}

export const GET = proxy;
export const POST = proxy;
