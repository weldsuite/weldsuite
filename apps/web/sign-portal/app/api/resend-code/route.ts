import { NextRequest, NextResponse } from 'next/server';
import { portalUpstream } from '@/lib/api';
import { upstreamHeaders } from '@/lib/session-route';

/** Asks sign-api to email a fresh code for the link token. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { token?: unknown };
  const res = await fetch(portalUpstream('/resend-code'), {
    method: 'POST',
    headers: upstreamHeaders(req),
    body: JSON.stringify({ token: String(body.token ?? '') }),
  });
  const json: unknown = await res.json().catch(() => ({}));
  return NextResponse.json(json, { status: res.status });
}
