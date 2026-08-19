import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { portalUpstream, sessionCookieName } from '@/lib/api';

async function forward(req: NextRequest, slug: string, path: string) {
  const token = (await cookies()).get(sessionCookieName())?.value;
  const dest = new URL(portalUpstream(slug, path));
  req.nextUrl.searchParams.forEach((value, key) => {
    if (key !== 'slug') dest.searchParams.set(key, value);
  });

  const headers: Record<string, string> = {
    'X-Workspace-Slug': slug,
    Accept: req.headers.get('Accept') || 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const contentType = req.headers.get('Content-Type');
  if (contentType) headers['Content-Type'] = contentType;

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }

  const res = await fetch(dest.toString(), init);
  const body = await res.arrayBuffer();
  const outHeaders = new Headers();
  const pass = ['content-type', 'content-disposition'];
  for (const name of pass) {
    const v = res.headers.get(name);
    if (v) outHeaders.set(name, v);
  }
  return new NextResponse(body, { status: res.status, headers: outHeaders });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const slug = req.nextUrl.searchParams.get('slug') || '';
  return forward(req, slug, `/${path.join('/')}`);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const slug = req.nextUrl.searchParams.get('slug') || '';
  return forward(req, slug, `/${path.join('/')}`);
}
