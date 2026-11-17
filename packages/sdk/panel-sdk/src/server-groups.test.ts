/** The server SDK's groups, and the install page's proxy recipes and snippet. */

import { describe, expect, it, vi } from 'vitest';
import * as domain from '../../../domains/panel/src/wire';
import { DEFAULT_PROXY_PATH, installSnippet, PROXY_RECIPES, proxyRecipe, STUB } from './install';
import { createPanelServer, toServerEvent } from './server';
import type { ServerBatch } from './wire';

const SECRET = `wps_${'0123456789abcdef'.repeat(2)}`;

describe('server SDK groups', () => {
  it('adds $group_<type> properties to a tracked event, valid groups only', () => {
    const event = toServerEvent({ name: 'Invoice paid', distinctId: 'user-1', props: { total: 12 }, groups: { company: 'acme', Team: 'x', workspace: 7, empty: '' } });
    expect(event?.props).toEqual({ total: 12, $group_company: 'acme', $group_workspace: '7' });
  });

  it('sends groupSet() operations with flush(), alone or with events, and the collector schema takes them', async () => {
    const bodies: ServerBatch[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as ServerBatch);
      return new Response(JSON.stringify({ accepted: 0, dropped: 0 }), { status: 200 });
    });
    const panel = createPanelServer({ secretKey: SECRET, fetch: fetch as unknown as typeof globalThis.fetch });
    panel.groupSet('company', 'acme', { name: 'Acme', plan: 'pro', nested: {} });
    panel.groupSet('Bad Type', 'acme', {});
    const result = await panel.flush();

    expect(result.dropped).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.events).toEqual([]);
    expect(bodies[0]!.groups).toEqual([{ op: 'set', type: 'company', key: 'acme', props: { $name: 'Acme', plan: 'pro' } }]);
    expect(domain.parseServerBatch(bodies[0], domain.MAX_TRACK_EVENTS)).toMatchObject({ ok: true, groupsDropped: 0 });
  });
});

describe('install', () => {
  it('adds the new methods to the stub, which queues them', () => {
    const w = {} as { weldpanel?: { q: unknown[]; group(...a: unknown[]): void; groups: { set(...a: unknown[]): void }; register(...a: unknown[]): void } };
    // The stub reads `window`: hand it a plain object instead.
    new Function('window', STUB)(w);
    w.weldpanel!.register({ plan: 'pro' });
    w.weldpanel!.group('company', 'acme');
    w.weldpanel!.groups.set('company', 'acme', { plan: 'pro' });
    expect(w.weldpanel!.q).toEqual([
      ['register', [{ plan: 'pro' }]],
      ['group', ['company', 'acme']],
      ['groups.set', ['company', 'acme', { plan: 'pro' }]],
    ]);
  });

  it('puts data-api-host on the script tag only when asked', () => {
    expect(installSnippet('wpk_x', 'https://pnl.weldsuite.org')).not.toContain('data-api-host');
    expect(installSnippet('wpk_x', 'https://pnl.weldsuite.org', { apiHost: 'https://shop.example.com/wp/' })).toContain(
      'data-project="wpk_x" data-api-host="https://shop.example.com/wp"',
    );
  });

  it('has a recipe for each proxy that forwards the path, the visitor address and no cookies', () => {
    expect(Object.keys(PROXY_RECIPES).sort()).toEqual(['cloudflare-worker', 'nextjs', 'nginx', 'vercel']);
    expect(PROXY_RECIPES.nextjs).toContain(`source: '${DEFAULT_PROXY_PATH}/:path*', destination: 'https://pnl.weldsuite.org/:path*'`);
    expect(JSON.parse(PROXY_RECIPES.vercel)).toEqual({ rewrites: [{ source: '/wp/:path*', destination: 'https://pnl.weldsuite.org/:path*' }] });
    expect(PROXY_RECIPES['cloudflare-worker']).toContain("headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '')");
    expect(PROXY_RECIPES['cloudflare-worker']).toContain('X-WeldPanel-Country');
    expect(PROXY_RECIPES['cloudflare-worker']).toContain("headers.delete('Cookie')");
    expect(PROXY_RECIPES.nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(proxyRecipe('nginx', { path: 'stats/', collector: 'https://collect.example.com/' })).toContain('location /stats/ {\n    proxy_pass https://collect.example.com/;');
  });

  it('gives a Cloudflare Worker that strips the proxy path', async () => {
    const source = proxyRecipe('cloudflare-worker').replace('export default', 'return');
    const worker = new Function(source)() as { fetch(request: Request & { cf?: Record<string, string> }): Promise<Response> };
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init.headers) });
      return new Response(null, { status: 204 });
    });
    const request = new Request('https://shop.example.com/wp/e?x=1', { method: 'POST', body: '{}', headers: { 'CF-Connecting-IP': '198.51.100.9', Cookie: 'a=b' } });
    Object.defineProperty(request, 'cf', { value: { country: 'DE', city: 'Berlin Mitte' } });
    await worker.fetch(request);
    vi.unstubAllGlobals();

    expect(seen[0]!.url).toBe('https://pnl.weldsuite.org/e?x=1');
    expect(seen[0]!.headers.get('X-Forwarded-For')).toBe('198.51.100.9');
    expect(seen[0]!.headers.get('X-WeldPanel-City')).toBe('Berlin%20Mitte');
    expect(seen[0]!.headers.get('Cookie')).toBeNull();
  });
});
