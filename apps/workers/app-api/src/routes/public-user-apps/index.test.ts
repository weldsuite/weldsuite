/**
 * The public WeldApps bundle host against a real pglite master DB, a fake R2
 * bucket and a fake KV: plain URLs for public approved apps, signed
 * workspace-bound links for everything else, and the response hardening.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.db };
});

import { bundleHostGuard, bundleHostRejection, publicUserAppsRoutes } from './index';
import { signBundleCapability, type BundleEnv } from '../../services/user-apps-bundle-access';
import { assetCacheKey } from '../../services/user-apps';

const { userApps, userAppVersions, userAppInstalls } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let db: any;

const SECRET = 'internal-secret-for-tests';
const OWNER = 'ws_owner';
const INSTALLER = 'ws_installer';
const STRANGER = 'ws_stranger';

class FakeKv {
  readonly store = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** A just-enough R2: serves the bundle files listed per app. */
function fakeBucket(files: Record<string, string>): R2Bucket {
  return {
    get: async (key: string) => {
      const body = files[key];
      if (body === undefined) return null;
      return { body, httpEtag: '"etag"', httpMetadata: undefined } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

const FILES: Record<string, string> = {
  'user-apps/uapp_priv/v1/index.html': '<html>private</html>',
  'user-apps/uapp_priv/v1/assets/index-abcdef12.js': 'console.log("private")',
  'user-apps/uapp_pub/v1/index.html': '<html>public</html>',
  'user-apps/uapp_pub/v1/assets/index-abcdef12.js': 'console.log("public")',
  'user-apps/uapp_other/v1/index.html': '<html>other</html>',
};

let kv: FakeKv;

function host(env: Partial<BundleEnv> = {}) {
  const { request } = createTestApp('/public/user-apps', publicUserAppsRoutes, {
    env: {
      WORKSPACE_CACHE: kv as unknown as KVNamespace,
      STORAGE: fakeBucket(FILES),
      INTERNAL_API_SECRET: SECRET,
      ...env,
    } as never,
  });
  return request;
}

async function link(appId: string, workspaceId: string, extra: { ttlSeconds?: number; nowMs?: number } = {}) {
  const minted = await signBundleCapability({ INTERNAL_API_SECRET: SECRET } as BundleEnv, { appId, workspaceId, ...extra });
  if (!minted) throw new Error('no link');
  return minted.token;
}

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  state.db = db;

  await db.insert(userApps).values([
    {
      id: 'uapp_priv',
      code: 'privapp',
      name: 'Private',
      ownerWorkspaceId: OWNER,
      createdBy: 'user_owner',
      visibility: 'private',
      reviewStatus: 'draft',
      currentVersionId: 'uav_priv',
    },
    {
      id: 'uapp_pub',
      code: 'pubapp',
      name: 'Public',
      ownerWorkspaceId: OWNER,
      createdBy: 'user_owner',
      visibility: 'public',
      reviewStatus: 'approved',
      currentVersionId: 'uav_pub',
    },
    {
      id: 'uapp_other',
      code: 'otherapp',
      name: 'Other private',
      ownerWorkspaceId: STRANGER,
      createdBy: 'user_stranger',
      visibility: 'private',
      reviewStatus: 'draft',
      currentVersionId: 'uav_other',
    },
  ]);
  await db.insert(userAppVersions).values([
    { id: 'uav_priv', appId: 'uapp_priv', version: '1.0.0', bundleKey: 'user-apps/uapp_priv/v1', createdBy: 'user_owner', status: 'published' },
    { id: 'uav_pub', appId: 'uapp_pub', version: '1.0.0', bundleKey: 'user-apps/uapp_pub/v1', createdBy: 'user_owner', status: 'published' },
    { id: 'uav_other', appId: 'uapp_other', version: '1.0.0', bundleKey: 'user-apps/uapp_other/v1', createdBy: 'user_stranger', status: 'published' },
  ]);
  // The installer workspace has the private app installed (e.g. an app that went
  // through review once and is now back in re-review).
  await db.insert(userAppInstalls).values({
    id: 'uai_priv_installer',
    appId: 'uapp_priv',
    workspaceId: INSTALLER,
    status: 'active',
    installedBy: 'user_installer',
  });
}, 60_000);

beforeEach(() => {
  kv = new FakeKv();
});

describe('public approved app', () => {
  it('is served at the plain URL, with no signed link', async () => {
    const res = await host()('/public/user-apps/pubapp/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>public</html>');
  });

  it('serves the entrypoint at the bare code and for extension-less paths', async () => {
    const bare = await host()('/public/user-apps/pubapp');
    expect(bare.status).toBe(200);
    const spa = await host()('/public/user-apps/pubapp/orders/42');
    expect(await spa.text()).toBe('<html>public</html>');
  });

  it('keeps long-lived public caching, and still ignores a link if one is present', async () => {
    const res = await host()('/public/user-apps/pubapp/assets/index-abcdef12.js');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('referrer-policy')).toBeNull();

    const token = await link('uapp_pub', STRANGER);
    const withLink = await host()(`/public/user-apps/pubapp/s/${token}/index.html`);
    expect(withLink.status).toBe(200);
  });
});

describe('private / unreviewed app', () => {
  it('is NOT served at the plain URL, even though a workspace has it installed', async () => {
    const res = await host()('/public/user-apps/privapp/index.html');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(await host()('/public/user-apps/privapp')).toHaveProperty('status', 404);
  });

  it('is served behind a signed link for the authoring workspace', async () => {
    const token = await link('uapp_priv', OWNER);
    const res = await host()(`/public/user-apps/privapp/s/${token}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>private</html>');
  });

  it('is served behind a signed link for a workspace with an active install', async () => {
    const token = await link('uapp_priv', INSTALLER);
    const res = await host()(`/public/user-apps/privapp/s/${token}/index.html`);
    expect(res.status).toBe(200);
  });

  it('keeps the link on lazily loaded chunks (relative assets under the same path)', async () => {
    const token = await link('uapp_priv', OWNER);
    const res = await host()(`/public/user-apps/privapp/s/${token}/assets/index-abcdef12.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("private")');
  });

  it('refuses a link for a workspace that has no access to the app', async () => {
    const token = await link('uapp_priv', STRANGER);
    const res = await host()(`/public/user-apps/privapp/s/${token}/index.html`);
    expect(res.status).toBe(404);
  });

  it('refuses a link minted for a different app', async () => {
    const token = await link('uapp_other', STRANGER);
    const res = await host()(`/public/user-apps/privapp/s/${token}/index.html`);
    expect(res.status).toBe(404);
    // ...while it still opens the app it was minted for.
    const own = await host()(`/public/user-apps/otherapp/s/${token}/index.html`);
    expect(own.status).toBe(200);
  });

  it('refuses a tampered link: workspace swapped for one with access', async () => {
    const stranger = await link('uapp_priv', STRANGER);
    const owner = await link('uapp_priv', OWNER);
    const [exp, , signature] = stranger.split('.');
    const [, ownerWorkspace] = owner.split('.');
    const res = await host()(`/public/user-apps/privapp/s/${exp}.${ownerWorkspace}.${signature}/index.html`);
    expect(res.status).toBe(404);
  });

  it('refuses garbage and answers exactly like an unknown app', async () => {
    const unknown = await host()('/public/user-apps/nosuchapp/index.html');
    const garbage = await host()('/public/user-apps/privapp/s/not-a-token/index.html');
    expect(garbage.status).toBe(unknown.status);
    const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
    expect(await code(garbage)).toBe(await code(unknown));
  });

  it('answers 403 BUNDLE_LINK_EXPIRED for an authentic but expired link', async () => {
    const token = await link('uapp_priv', OWNER, { nowMs: Date.now() - 13 * 60 * 60 * 1000 });
    const res = await host()(`/public/user-apps/privapp/s/${token}/index.html`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BUNDLE_LINK_EXPIRED');
  });

  it('fails closed when no signing secret is configured', async () => {
    const token = await link('uapp_priv', OWNER);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await host({ INTERNAL_API_SECRET: undefined } as Partial<BundleEnv>)(
      `/public/user-apps/privapp/s/${token}/index.html`,
    );
    errors.mockRestore();
    expect(res.status).toBe(404);
  });

  it('marks gated responses private and keeps the link out of Referer', async () => {
    const token = await link('uapp_priv', OWNER);
    const asset = await host()(`/public/user-apps/privapp/s/${token}/assets/index-abcdef12.js`);
    expect(asset.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(Number(asset.headers.get('cache-control')?.split('=')[1])).toBeLessThanOrEqual(24 * 60 * 60);
    expect(asset.headers.get('referrer-policy')).toBe('strict-origin');
    const html = await host()(`/public/user-apps/privapp/s/${token}/index.html`);
    expect(html.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('stops serving within the cache window once the install is revoked', async () => {
    const token = await link('uapp_priv', INSTALLER);
    expect((await host()(`/public/user-apps/privapp/s/${token}/index.html`)).status).toBe(200);

    await db.update(userAppInstalls).set({ status: 'revoked' }).where(eq(userAppInstalls.id, 'uai_priv_installer'));
    try {
      // The 60s verdict cache still says yes until it is dropped (the uninstall route drops it).
      kv.store.clear();
      expect((await host()(`/public/user-apps/privapp/s/${token}/index.html`)).status).toBe(404);
    } finally {
      await db.update(userAppInstalls).set({ status: 'active' }).where(eq(userAppInstalls.id, 'uai_priv_installer'));
    }
  });

  it('stops serving when the app is deactivated', async () => {
    const token = await link('uapp_priv', OWNER);
    await db.update(userApps).set({ isActive: false }).where(eq(userApps.id, 'uapp_priv'));
    try {
      expect((await host()(`/public/user-apps/privapp/s/${token}/index.html`)).status).toBe(404);
    } finally {
      await db.update(userApps).set({ isActive: true }).where(eq(userApps.id, 'uapp_priv'));
    }
  });

  it('treats a cached entry without the requiresToken flag as gated', async () => {
    kv.store.set(
      assetCacheKey('privapp'),
      JSON.stringify({ appId: 'uapp_priv', bundleKey: 'user-apps/uapp_priv/v1', entrypoint: 'index.html' }),
    );
    expect((await host()('/public/user-apps/privapp/index.html')).status).toBe(404);
  });
});

describe('response hardening', () => {
  it('limits framing to the platform instead of `*`, and blocks sniffing', async () => {
    const res = await host()('/public/user-apps/pubapp/index.html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://app.weldsuite.org');
    expect(csp).not.toMatch(/frame-ancestors[^;]*\s\*(\s|;|$)/);
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Opaque-origin sandboxes still load sibling assets.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('adds configured frame ancestors', async () => {
    const res = await host({ USER_APP_FRAME_ANCESTORS: 'https://embed.example.com' } as Partial<BundleEnv>)(
      '/public/user-apps/pubapp/index.html',
    );
    expect(res.headers.get('content-security-policy')).toContain('https://embed.example.com');
  });

  it('refuses service worker script fetches, so registration fails', async () => {
    const res = await host()('/public/user-apps/pubapp/sw.js', { headers: { 'Service-Worker': 'script' } });
    expect(res.status).toBe(403);
    const token = await link('uapp_priv', OWNER);
    const gated = await host()(`/public/user-apps/privapp/s/${token}/sw.js`, { headers: { 'Service-Worker': 'script' } });
    expect(gated.status).toBe(403);
  });

  it('refuses path traversal', async () => {
    const res = await host()('/public/user-apps/pubapp/%2e%2e/priv/index.html');
    expect(res.status).toBe(404);
  });
});

describe('dedicated bundle origin', () => {
  const bundleOrigin = { USER_APP_BUNDLE_ORIGIN: 'https://weldappcontent.net' } as Partial<BundleEnv>;

  it('serves bundles on the bundle origin only', async () => {
    const onBundleHost = await host(bundleOrigin)('https://weldappcontent.net/public/user-apps/pubapp/index.html');
    expect(onBundleHost.status).toBe(200);
    const onApiHost = await host(bundleOrigin)('https://app-api.weldsuite.org/public/user-apps/pubapp/index.html');
    expect(onApiHost.status).toBe(404);
    // Gated bundles too, even with a valid link.
    const token = await link('uapp_priv', OWNER);
    const gatedOnApiHost = await host(bundleOrigin)(
      `https://app-api.weldsuite.org/public/user-apps/privapp/s/${token}/index.html`,
    );
    expect(gatedOnApiHost.status).toBe(404);
    const gatedOnBundleHost = await host(bundleOrigin)(
      `https://weldappcontent.net/public/user-apps/privapp/s/${token}/index.html`,
    );
    expect(gatedOnBundleHost.status).toBe(200);
  });

  it('fails closed on an unusable bundle origin', async () => {
    const res = await host({ USER_APP_BUNDLE_ORIGIN: 'not a url' } as Partial<BundleEnv>)(
      'https://app-api.weldsuite.org/public/user-apps/pubapp/index.html',
    );
    expect(res.status).toBe(404);
  });

  it('with one origin per app, an app is served only on its own origin', async () => {
    const perApp = { USER_APP_BUNDLE_ORIGIN: 'https://{code}.weldappcontent.net' } as Partial<BundleEnv>;
    expect((await host(perApp)('https://pubapp.weldappcontent.net/public/user-apps/pubapp/index.html')).status).toBe(200);
    expect((await host(perApp)('https://otherapp.weldappcontent.net/public/user-apps/pubapp/index.html')).status).toBe(404);
  });
});

describe('bundleHostGuard', () => {
  function guarded(env: Record<string, unknown>) {
    const app = new Hono();
    app.use('*', bundleHostGuard as never);
    app.get('/api/customers', (c) => c.json({ data: 'secret' }));
    app.get('/public/user-apps/:code', (c) => c.text('bundle'));
    app.get('/health', (c) => c.text('ok'));
    return (url: string) => app.request(url, undefined, env);
  }

  it('is a no-op without a bundle origin', async () => {
    const request = guarded({});
    expect((await request('https://app-api.weldsuite.org/api/customers')).status).toBe(200);
    expect((await request('https://app-api.weldsuite.org/health')).status).toBe(200);
  });

  it('keeps the API off the bundle host while the API host is untouched', async () => {
    const request = guarded({ USER_APP_BUNDLE_ORIGIN: 'https://weldappcontent.net' });
    expect((await request('https://weldappcontent.net/api/customers')).status).toBe(404);
    expect((await request('https://weldappcontent.net/health')).status).toBe(404);
    expect((await request('https://weldappcontent.net/public/user-apps/demo')).status).toBe(200);
    expect((await request('https://app-api.weldsuite.org/api/customers')).status).toBe(200);
  });

  it('does the same per app', async () => {
    const request = guarded({ USER_APP_BUNDLE_ORIGIN: 'https://{code}.weldappcontent.net' });
    expect((await request('https://demo.weldappcontent.net/api/customers')).status).toBe(404);
    expect((await request('https://demo.weldappcontent.net/public/user-apps/demo')).status).toBe(200);
    expect((await request('https://app-api.weldsuite.org/api/customers')).status).toBe(200);
  });

  it('is available as a plain pre-router check for the worker fetch handler', () => {
    const env = { USER_APP_BUNDLE_ORIGIN: 'https://weldappcontent.net' } as never;
    expect(bundleHostRejection(new Request('https://weldappcontent.net/api/crm/leads'), env)?.status).toBe(404);
    expect(bundleHostRejection(new Request('https://weldappcontent.net/public/user-apps/demo/index.html'), env)).toBeNull();
    expect(bundleHostRejection(new Request('https://app-api.weldsuite.org/api/crm/leads'), env)).toBeNull();
    expect(bundleHostRejection(new Request('https://weldappcontent.net/api/crm/leads'), {} as never)).toBeNull();
  });
});
