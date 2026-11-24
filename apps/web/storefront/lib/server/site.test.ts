import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSiteCache, completeDocument, loadSite, SiteUnavailableError } from './site';

function site(versionId: string, preview = false) {
  return {
    data: {
      workspaceId: 'ws_1',
      channelId: 'ch_1',
      siteId: 'sfs_1',
      host: 'shop.example.com',
      primaryHost: 'shop.example.com',
      primaryOrigin: 'https://shop.example.com',
      origins: ['https://shop.example.com'],
      locale: 'nl',
      visibility: 'live',
      preview,
      version: { id: versionId, number: preview ? null : 2, document: { schemaVersion: 1, templates: {}, groups: {}, seo: {}, settings: { access: 'public', cookieBanner: false } } },
      channel: { id: 'ch_1', name: 'Shop', audience: 'b2c', currency: 'EUR', pricesIncludeTax: true, guestCheckout: true, paymentMethods: ['mollie'] },
    },
  };
}

describe('site loading', () => {
  // Made at run time: the tests depend on no fixed secret.
  const SECRET = `s_${crypto.randomUUID()}`;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    clearSiteCache();
    vi.stubEnv('STOREFRONT_API_URL', 'http://api.test/');
    vi.stubEnv('STOREFRONT_RENDERER_SECRET', SECRET);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('asks the server with the renderer secret and keeps a published version', async () => {
    fetchMock.mockImplementation(async () => Response.json(site('sfv_2')));
    const first = await loadSite({ host: 'shop.example.com', versionHint: 'sfv_2' });
    const second = await loadSite({ host: 'shop.example.com', versionHint: 'sfv_2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/public/storefront/site?host=shop.example.com');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(second).toBe(first);
    // Missing templates and groups come from the theme's defaults.
    expect(first.version.document.templates.product.length).toBeGreaterThan(0);
    expect(first.version.document.groups.header[0]?.type).toBe('header');
  });

  it('asks again when the edge knows a newer version', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json(site('sfv_2'))).mockImplementationOnce(async () => Response.json(site('sfv_3')));
    await loadSite({ host: 'shop.example.com', versionHint: 'sfv_2' });
    const newer = await loadSite({ host: 'shop.example.com', versionHint: 'sfv_3' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(newer.version.id).toBe('sfv_3');
  });

  it('never caches a preview', async () => {
    fetchMock.mockImplementation(async () => Response.json(site('draft', true)));
    await loadSite({ host: 'shop.example.com', previewToken: 'tok' });
    await loadSite({ host: 'shop.example.com', previewToken: 'tok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('preview=tok');
  });

  it('reports an unknown host and an unpublished site as 404s', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ error: { code: 'NOT_PUBLISHED', message: 'x' } }, { status: 404 }));
    await expect(loadSite({ host: 'new.example.com' })).rejects.toMatchObject({ code: 'NOT_PUBLISHED', status: 404 });
    fetchMock.mockImplementationOnce(async () => Response.json({ error: { code: 'SITE_NOT_FOUND', message: 'x' } }, { status: 404 }));
    await expect(loadSite({ host: 'nope.example.com' })).rejects.toBeInstanceOf(SiteUnavailableError);
  });

  it('fills a partial document with the theme defaults', () => {
    const doc = completeDocument({ templates: { home: [] } });
    expect(doc.templates.home).toEqual([]);
    expect(doc.pages).toEqual([]);
    expect(doc.settings.access).toBe('public');
  });
});
