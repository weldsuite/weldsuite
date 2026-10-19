/**
 * Storage upload broker hardening:
 *   - TASK-619: confirm-upload works on the token's own key, never a
 *     caller-supplied one (that was a size/URL oracle for any tenant's object).
 *   - TASK-621: upload tokens are long CSPRNG secrets, not generateId ids.
 *   - TASK-638: the dev-only public read answers localhost requests only.
 *   - TASK-620: `isPublic` picks the bucket; private objects are readable only
 *     by a member of the key's workspace (files cookie, bearer, signed URL).
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { storageRoutes, storageUploadTokenRoute } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';

vi.mock('@clerk/backend', () => ({
  verifyToken: async (token: string) => {
    if (token === 'jwt-org-a') return { sub: 'user_a', o: { id: 'org_a' } };
    if (token === 'jwt-org-b') return { sub: 'user_b', o: { id: 'org_b' } };
    throw new Error('bad token');
  },
}));

function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

interface StoredObject {
  body: string;
  contentType: string;
  fileName?: string;
}

function memoryBucket(keys: string[] = [], contentType = 'application/pdf') {
  const objects = new Map<string, StoredObject>(keys.map((k) => [k, { body: 'secret', contentType }]));
  const toObject = (key: string, o: StoredObject) => ({
    key,
    size: o.body.length,
    body: o.body,
    httpEtag: '"e"',
    customMetadata: o.fileName ? { fileName: o.fileName } : {},
    writeHttpMetadata: (h: Headers) => h.set('content-type', o.contentType),
  });
  const bucket = {
    objects,
    head: async (key: string) => (objects.has(key) ? toObject(key, objects.get(key)!) : null),
    get: async (key: string) => (objects.has(key) ? toObject(key, objects.get(key)!) : null),
    put: async (
      key: string,
      body: ArrayBuffer,
      opts?: { httpMetadata?: { contentType?: string }; customMetadata?: { fileName?: string } },
    ) => {
      objects.set(key, {
        body: new TextDecoder().decode(body),
        contentType: opts?.httpMetadata?.contentType ?? 'application/octet-stream',
        fileName: opts?.customMetadata?.fileName,
      });
      return { etag: 'etag-1' };
    },
  };
  return bucket as typeof bucket & R2Bucket;
}

const VICTIM_KEY = 'workspaces/org_victim/uploads/general/1_x/payroll.pdf';
const OWN_KEY = 'workspaces/org_a/drive/general/1_y/payroll.pdf';
const SIGNING_KEY = 'test-signing-key';
const API = 'https://app-api.example';

interface Buckets {
  STORAGE: ReturnType<typeof memoryBucket>;
  PRIVATE_STORAGE?: ReturnType<typeof memoryBucket>;
}

function brokerApp(kv: KVNamespace, buckets: Buckets, extraEnv: Record<string, unknown> = {}) {
  return createTestApp('/api/storage', storageRoutes, {
    context: { userId: 'user_a', workspaceId: 'org_a', orgId: 'org_a' },
    env: {
      WORKSPACE_CACHE: kv,
      R2_PUBLIC_URL: 'https://files.example',
      STORAGE_SIGNING_KEY: SIGNING_KEY,
      ...buckets,
      ...extraEnv,
    } as never,
  });
}

function post(app: ReturnType<typeof brokerApp>, path: string, body: unknown) {
  return app.request(`${API}/api/storage${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const tokenApp = new Hono().route('/', storageUploadTokenRoute);

/** Generate → PUT → confirm, returning what confirm-upload hands back. */
async function upload(buckets: Buckets, input: Record<string, unknown>) {
  const kv = memoryKv();
  const app = brokerApp(kv, buckets);
  const gen = await post(app, '/generate-upload-url', {
    fileName: 'payroll.pdf',
    contentType: 'application/pdf',
    fileSize: 6,
    ...input,
  });
  const { uploadToken, fileKey, uploadUrl } = (await gen.json()) as {
    uploadToken: string;
    fileKey: string;
    uploadUrl: string;
  };
  const put = await tokenApp.request(uploadUrl, { method: 'PUT', body: 'secret' }, { WORKSPACE_CACHE: kv, ...buckets });
  expect(put.status).toBe(200);
  const res = await post(app, '/confirm-upload', { uploadToken, fileKey });
  expect(res.status).toBe(200);
  return ((await res.json()) as { file: { fileKey: string; url: string; isPublic: boolean; bucket: string } }).file;
}

describe('upload broker', () => {
  it('issues long, unguessable upload tokens', async () => {
    const app = brokerApp(memoryKv(), { STORAGE: memoryBucket(), PRIVATE_STORAGE: memoryBucket() });
    const res = await post(app, '/generate-upload-url', { fileName: 'a.txt', contentType: 'text/plain', fileSize: 1 });
    const { uploadToken } = (await res.json()) as { uploadToken: string };
    expect(uploadToken).toMatch(/^upl_[A-Za-z0-9]{32}$/);
  });

  it("refuses to confirm another tenant's key", async () => {
    const kv = memoryKv();
    const app = brokerApp(kv, { STORAGE: memoryBucket([VICTIM_KEY]), PRIVATE_STORAGE: memoryBucket([VICTIM_KEY]) });
    const gen = await post(app, '/generate-upload-url', { fileName: 'a.txt', contentType: 'text/plain', fileSize: 1 });
    const { uploadToken } = (await gen.json()) as { uploadToken: string };

    const res = await post(app, '/confirm-upload', { uploadToken, fileKey: VICTIM_KEY });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('files.example');
  });

  it('confirms the key the token was issued for', async () => {
    const kv = memoryKv();
    const gen = await post(brokerApp(kv, { STORAGE: memoryBucket() }), '/generate-upload-url', {
      fileName: 'a.txt',
      contentType: 'text/plain',
      fileSize: 1,
      isPublic: true,
    });
    const { uploadToken, fileKey } = (await gen.json()) as { uploadToken: string; fileKey: string };
    expect(fileKey.startsWith('workspaces/org_a/')).toBe(true);

    const res = await post(brokerApp(kv, { STORAGE: memoryBucket([fileKey]) }), '/confirm-upload', { uploadToken, fileKey });
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as { file: { fileKey: string; fileSize: number } };
    expect(file).toMatchObject({ fileKey, fileSize: 6 });
  });
});

describe('isPublic picks the bucket (TASK-620)', () => {
  it('puts a private upload in the private bucket, behind an app-api URL', async () => {
    const buckets = { STORAGE: memoryBucket(), PRIVATE_STORAGE: memoryBucket() };
    const file = await upload(buckets, {});
    expect(file).toMatchObject({ isPublic: false, bucket: 'private' });
    expect(file.url).toBe(`${API}/api/storage/private/${file.fileKey}`);
    expect(buckets.PRIVATE_STORAGE.objects.has(file.fileKey)).toBe(true);
    expect(buckets.STORAGE.objects.size).toBe(0);
  });

  it('puts a public upload on the public domain', async () => {
    const buckets = { STORAGE: memoryBucket(), PRIVATE_STORAGE: memoryBucket() };
    const file = await upload(buckets, { isPublic: true });
    expect(file).toMatchObject({ isPublic: true, bucket: 'public' });
    expect(file.url).toBe(`https://files.example/${file.fileKey}`);
    expect(buckets.PRIVATE_STORAGE.objects.size).toBe(0);
  });

  it('keeps avatars and app logos public whatever isPublic says', async () => {
    for (const entityType of ['customer-avatar', 'contact-avatar', 'user-app-logo']) {
      const buckets = { STORAGE: memoryBucket(), PRIVATE_STORAGE: memoryBucket() };
      const file = await upload(buckets, { entityType, entityId: 'x1', isPublic: false });
      expect(file.bucket).toBe('public');
    }
  });

  it('refuses a private upload in production without the private bucket', async () => {
    const app = brokerApp(memoryKv(), { STORAGE: memoryBucket() }, { ENVIRONMENT: 'production' });
    const res = await post(app, '/generate-upload-url', { fileName: 'a.pdf', contentType: 'application/pdf', fileSize: 1 });
    expect(res.status).toBe(503);
  });

  it('falls back to the public bucket outside production without the private bucket', async () => {
    const buckets = { STORAGE: memoryBucket() };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await upload(buckets, {});
    warn.mockRestore();
    expect(file.bucket).toBe('public');
  });
});

describe('GET /api/storage/private/*', () => {
  const env = () => ({
    STORAGE_SIGNING_KEY: SIGNING_KEY,
    CLERK_SECRET_KEY: 'sk_test',
    PRIVATE_STORAGE: memoryBucket([OWN_KEY, VICTIM_KEY]),
  });
  const url = (key: string) => `${API}/api/storage/private/${key}`;

  async function filesCookie(workspaceId = 'org_a') {
    const app = createTestApp('/api/storage', storageRoutes, {
      context: { userId: 'user_a', workspaceId, orgId: workspaceId },
      env: { STORAGE_SIGNING_KEY: SIGNING_KEY } as never,
    });
    const res = await app.request(`${API}/api/storage/access`, { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain(`Path=/api/storage/private/workspaces/${workspaceId}/`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    return setCookie.split(';')[0]!;
  }

  it('401s without any credential', async () => {
    const res = await tokenApp.request(url(OWN_KEY), {}, env());
    expect(res.status).toBe(401);
  });

  it("serves the caller's workspace with its files cookie", async () => {
    const res = await tokenApp.request(url(OWN_KEY), { headers: { Cookie: await filesCookie() } }, env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('secret');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
  });

  it("404s another workspace's key with a valid cookie", async () => {
    const res = await tokenApp.request(url(VICTIM_KEY), { headers: { Cookie: await filesCookie() } }, env());
    expect(res.status).toBe(404);
  });

  it('accepts a bearer token for the same workspace only', async () => {
    const ok = await tokenApp.request(url(OWN_KEY), { headers: { Authorization: 'Bearer jwt-org-a' } }, env());
    expect(ok.status).toBe(200);
    const other = await tokenApp.request(url(OWN_KEY), { headers: { Authorization: 'Bearer jwt-org-b' } }, env());
    expect(other.status).toBe(404);
    const bad = await tokenApp.request(url(OWN_KEY), { headers: { Authorization: 'Bearer forged' } }, env());
    expect(bad.status).toBe(404);
  });

  it('serves a signed URL for its own key only', async () => {
    const app = brokerApp(memoryKv(), { STORAGE: memoryBucket() });
    const res = await post(app, '/sign', { files: [url(OWN_KEY), VICTIM_KEY] });
    const { data } = (await res.json()) as { data: Record<string, { url: string }> };
    expect(Object.keys(data)).toEqual([url(OWN_KEY)]);

    const signed = data[url(OWN_KEY)]!.url;
    expect((await tokenApp.request(signed, {}, env())).status).toBe(200);

    const sig = new URL(signed).search;
    expect((await tokenApp.request(`${url(VICTIM_KEY)}${sig}`, {}, env())).status).toBe(404);
  });

  it('never renders active content inline', async () => {
    const bucket = memoryBucket(['workspaces/org_a/x/1_z/page.html'], 'text/html');
    const res = await tokenApp.request(
      url('workspaces/org_a/x/1_z/page.html'),
      { headers: { Authorization: 'Bearer jwt-org-a' } },
      { ...env(), PRIVATE_STORAGE: bucket },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects traversal in the key', async () => {
    const res = await tokenApp.request(
      `${API}/api/storage/private/workspaces/org_a/..%2Forg_victim/uploads/x`,
      { headers: { Authorization: 'Bearer jwt-org-a' } },
      env(),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/storage/public/* (local dev only)', () => {
  const env = { ENVIRONMENT: 'development', STORAGE: memoryBucket([VICTIM_KEY]) };

  it('serves localhost in development', async () => {
    const res = await tokenApp.request(`http://localhost:8787/api/storage/public/${VICTIM_KEY}`, {}, env);
    expect(res.status).toBe(200);
  });

  it('404s a dev server reached through any other host', async () => {
    const res = await tokenApp.request(`https://my-tunnel.example/api/storage/public/${VICTIM_KEY}`, {}, env);
    expect(res.status).toBe(404);
  });

  it('404s outside development', async () => {
    const res = await tokenApp.request(`http://localhost:8787/api/storage/public/${VICTIM_KEY}`, {}, { ...env, ENVIRONMENT: 'test' });
    expect(res.status).toBe(404);
  });
});
