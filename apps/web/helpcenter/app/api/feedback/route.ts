import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.HELPCENTER_API_URL || 'http://localhost:8789';

export async function POST(request: NextRequest) {
  const { domain, articleId, helpful } = await request.json();

  if (!domain || !articleId || typeof helpful !== 'boolean') {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const url = new URL(`/public/helpcenter/articles/${articleId}/feedback`, API_URL);
  url.searchParams.set('domain', domain);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ helpful }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to submit feedback' }, { status: res.status });
  }

  return NextResponse.json({ success: true });
}
