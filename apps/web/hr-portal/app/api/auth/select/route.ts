import { NextRequest, NextResponse } from 'next/server';
import { portalUpstream, sessionCookieName } from '@/lib/api';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const slug = String(body.slug || req.nextUrl.searchParams.get('slug') || '');
  const pickerToken = String(body.pickerToken || '');
  const accessId = String(body.accessId || '');
  const res = await fetch(portalUpstream(slug, '/auth/select'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Slug': slug },
    body: JSON.stringify({ pickerToken, accessId }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: { session?: { token?: string; expiresIn?: number } } };
  const out = NextResponse.json(json, { status: res.status });
  const token = json.data?.session?.token;
  const expiresIn = json.data?.session?.expiresIn;
  if (token) {
    out.cookies.set(sessionCookieName(), token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: expiresIn ?? 60 * 60 * 24 * 30,
    });
  }
  return out;
}
