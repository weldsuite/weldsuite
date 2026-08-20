import { NextRequest, NextResponse } from 'next/server';
import { portalUpstream, sessionCookieName } from '@/lib/api';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const slug = String(body.slug || '');
  const res = await fetch(portalUpstream(slug, '/auth/select-company'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Slug': slug },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: { token?: string } };
  const out = NextResponse.json(json, { status: res.status });
  if (json.data?.token) {
    out.cookies.set(sessionCookieName(), json.data.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return out;
}
