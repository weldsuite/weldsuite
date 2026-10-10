/**
 * Route-level tests for POST /api/company-logos/resolve: the permission gate,
 * validation, the response envelope, and that a workspace's lookups never leave
 * its own storage namespace. The fetch pipeline itself is covered in
 * lib/company-logo.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { COMPANY_LOGO_BATCH_MAX } from '@weldsuite/app-api-client/schemas/company-logos';
import type { Env, Variables } from '../../types';
import { FakeR2 } from '../../test/fake-r2';
import { companyLogosRoutes } from './index';

const PUBLIC_URL = 'https://storage.example-cdn.org';

function png(): Uint8Array {
  const bytes = new Uint8Array(200);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function makeApp(opts: { perms?: string[]; storage?: FakeR2 | null; r2PublicUrl?: string | null } = {}) {
  const storage = opts.storage === undefined ? new FakeR2() : opts.storage;
  const app = createTestApp<Env, Variables>('/api/company-logos', companyLogosRoutes, {
    context: { workspaceId: 'ws_7', permissions: permissions(...(opts.perms ?? ['companies:read'])) },
    env: {
      ...(storage ? { STORAGE: storage.asBucket() } : {}),
      ...(opts.r2PublicUrl === null ? {} : { R2_PUBLIC_URL: opts.r2PublicUrl ?? PUBLIC_URL }),
    },
  });
  // Absolute URL: a bare path would be read as localhost, i.e. local dev.
  const post = (body: unknown, origin = 'https://crm-api.weldsuite.org') =>
    app.request(`${origin}/api/company-logos/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { storage, post };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/company-logos/resolve', () => {
  it('returns 403 without a CRM or lead-database read permission', async () => {
    const { post } = makeApp({ perms: ['tickets:read'] });
    const res = await post({ domains: ['acme.com'] });
    expect(res.status).toBe(403);
  });

  it.each(['companies:read', 'people:read', 'leads:read', 'prospects:read'])('accepts %s', async (perm) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const { post } = makeApp({ perms: [perm] });
    const res = await post({ domains: ['acme.com'] });
    expect(res.status).toBe(200);
  });

  it('rejects an empty, oversized or malformed batch with 400', async () => {
    const { post } = makeApp();
    expect((await post({ domains: [] })).status).toBe(400);
    expect((await post({ domains: Array.from({ length: COMPANY_LOGO_BATCH_MAX + 1 }, (_, i) => `d${i}.com`) })).status).toBe(400);
    expect((await post({ domains: [''] })).status).toBe(400);
    expect((await post({ domains: 'acme.com' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('answers { data: { logos } } keyed by what was sent, from the workspace namespace', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'https://acme.com/') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      if (input === 'https://acme.com/favicon.ico') return new Response(png());
      return new Response('nope', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { post, storage } = makeApp();
    const res = await post({ domains: ['https://www.acme.com/about', 'localhost', 'gmail.com'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        logos: {
          'https://www.acme.com/about': `${PUBLIC_URL}/workspaces/ws_7/company-logos/acme.com`,
          localhost: null,
          'gmail.com': null,
        },
      },
    });
    expect([...(storage?.objects.keys() ?? [])]).toEqual(['workspaces/ws_7/company-logos/acme.com']);
    // Nothing but the company's own site was contacted.
    const hosts = new Set(fetchMock.mock.calls.map(([url]) => new URL(url).hostname));
    expect([...hosts]).toEqual(['acme.com']);
  });

  it('hands out app-api storage URLs under local dev, where the bucket hostname is the remote one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) =>
      input === 'https://acme.com/favicon.ico' ? new Response(png()) : new Response('nope', { status: 404 }),
    ));
    const { post } = makeApp();
    const res = await post({ domains: ['acme.com'] }, 'http://localhost:8801');
    expect(await res.json()).toEqual({
      data: { logos: { 'acme.com': 'http://localhost:8789/api/storage/public/workspaces/ws_7/company-logos/acme.com' } },
    });
  });

  it('does not contact anyone for a domain that is already cached', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const storage = new FakeR2();
    await storage.put('workspaces/ws_7/company-logos/acme.com', png(), {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { status: 'hit', expiresAt: String(Date.now() + 60_000) },
    });
    await storage.put('workspaces/ws_7/company-logos/nologo.com', new Uint8Array(0), {
      customMetadata: { status: 'miss', expiresAt: String(Date.now() + 60_000) },
    });

    const { post } = makeApp({ storage });
    const res = await post({ domains: ['acme.com', 'nologo.com'] });
    expect(await res.json()).toEqual({
      data: {
        logos: {
          'acme.com': `${PUBLIC_URL}/workspaces/ws_7/company-logos/acme.com`,
          'nologo.com': null,
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers "no logos" instead of failing when storage is not bound', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { post } = makeApp({ storage: null });
    const res = await post({ domains: ['acme.com', 'beta.io'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { logos: { 'acme.com': null, 'beta.io': null } } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
