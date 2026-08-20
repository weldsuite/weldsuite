import { NextRequest, NextResponse } from 'next/server';
import { portalUpstream, sessionCookieName } from '@/lib/api';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const slug = String(body.slug || '');
  const token = req.cookies.get(sessionCookieName())?.value;
  if (token) {
    await fetch(portalUpstream(slug, '/auth/logout'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Slug': slug },
    }).catch(() => {});
  }
  const out = NextResponse.json({ data: { ok: true } });
  out.cookies.set(sessionCookieName(), '', { httpOnly: true, path: '/', maxAge: 0 });
  return out;
}
