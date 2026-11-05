import { describe, expect, it } from 'vitest';
import { isFetchableUrl, readPreview, unfurl } from './unfurl';

const html = (head: string) => new Response(`<html><head>${head}</head><body>${'x'.repeat(10)}</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('unfurl', () => {
  it('only fetches public http(s) addresses on the default ports', () => {
    for (const ok of ['https://example.com/a', 'http://www.weldsuite.org', 'https://example.com:443/x']) expect(isFetchableUrl(ok), ok).toBe(true);
    for (const bad of [
      'ftp://example.com',
      'https://localhost/',
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://192.168.0.1/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://[fd00::1]/',
      'https://printer.local/',
      'https://db.internal/',
      'https://example.com:8080/',
      'https://user:pass@example.com/',
      'https://intranet/',
    ])
      expect(isFetchableUrl(bad), bad).toBe(false);
  });

  it('reads Open Graph tags, decodes entities and resolves the image', () => {
    const preview = readPreview(
      `<title>Fallback</title><meta property="og:title" content="Plans &amp; ideas"><meta name='description' content='A &quot;board&quot;'><meta property="og:image" content="/img/card.png"><meta property="og:site_name" content="Example">`,
      'https://example.com/page',
    );
    expect(preview).toEqual({ title: 'Plans & ideas', description: 'A "board"', image: 'https://example.com/img/card.png', siteName: 'Example' });
    expect(readPreview('<title> Just a title </title>', 'https://www.example.org/')).toEqual({ title: 'Just a title', description: null, image: null, siteName: 'example.org' });
  });

  it('follows redirects only to addresses it may fetch, and never fails', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      if (url === 'https://short.example/x') return new Response(null, { status: 301, headers: { Location: 'https://example.com/long' } });
      if (url === 'https://example.com/long') return html('<meta property="og:title" content="Long page">');
      if (url === 'https://evil.example/') return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } });
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await unfurl('https://short.example/x', fetcher)).toMatchObject({ url: 'https://short.example/x', title: 'Long page' });
    expect(await unfurl('https://evil.example/', fetcher)).toEqual({ url: 'https://evil.example/', title: null, description: null, image: null, siteName: null });
    expect(calls).not.toContain('http://169.254.169.254/');
    expect((await unfurl('https://down.example/', fetcher)).title).toBeNull();
    expect((await unfurl('http://10.0.0.1/', fetcher)).title).toBeNull();
  });
});
