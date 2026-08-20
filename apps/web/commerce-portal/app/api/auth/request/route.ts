import { NextRequest, NextResponse } from 'next/server';
import { portalUpstream } from '@/lib/api';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const slug = String(body.slug || req.nextUrl.searchParams.get('slug') || '');
  const email = String(body.email || '');
  const res = await fetch(portalUpstream(slug, '/auth/request'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Slug': slug },
    body: JSON.stringify({ email, slug }),
  });
  const json = await res.json().catch(() => ({ data: { ok: true } }));
  return NextResponse.json(json, { status: res.status });
}
