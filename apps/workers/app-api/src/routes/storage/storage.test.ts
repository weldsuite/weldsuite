/**
 * Storage upload broker hardening:
 *   - TASK-619: confirm-upload works on the token's own key, never a
 *     caller-supplied one (that was a size/URL oracle for any tenant's object).
 *   - TASK-621: upload tokens are long CSPRNG secrets, not generateId ids.
 *   - TASK-638: the dev-only public read answers localhost requests only.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { storageRoutes, storageUploadTokenRoute } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';

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

function memoryBucket(keys: string[]): R2Bucket {
  const objects = new Set(keys);
  return {
    head: async (key: string) => (objects.has(key) ? { size: 42 } : null),
    get: async (key: string) =>
      objects.has(key)
        ? { body: 'secret', httpEtag: '"e"', writeHttpMetadata: () => {} }
        : null,
  } as unknown as R2Bucket;
}

const VICTIM_KEY = 'workspaces/org_victim/uploads/general/1_x/payroll.pdf';

function brokerApp(kv: KVNamespace, bucket: R2Bucket) {
  return createTestApp('/api/storage', storageRoutes, {
    context: { userId: 'user_a', workspaceId: 'org_a', orgId: 'org_a' },
    env: { WORKSPACE_CACHE: kv, STORAGE: bucket, R2_PUBLIC_URL: 'https://files.example' } as never,
  });
}

function post(app: ReturnType<typeof brokerApp>, path: string, body: unknown) {
  return app.request(`/api/storage${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('upload broker', () => {
  it('issues long, unguessable upload tokens', async () => {
    const app = brokerApp(memoryKv(), memoryBucket([]));
    const res = await post(app, '/generate-upload-url', { fileName: 'a.txt', contentType: 'text/plain', fileSize: 1 });
    const { uploadToken } = (await res.json()) as { uploadToken: string };
    expect(uploadToken).toMatch(/^upl_[A-Za-z0-9]{32}$/);
  });

  it("refuses to confirm another tenant's key", async () => {
    const kv = memoryKv();
    const app = brokerApp(kv, memoryBucket([VICTIM_KEY]));
    const gen = await post(app, '/generate-upload-url', { fileName: 'a.txt', contentType: 'text/plain', fileSize: 1 });
    const { uploadToken } = (await gen.json()) as { uploadToken: string };

    const res = await post(app, '/confirm-upload', { uploadToken, fileKey: VICTIM_KEY });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('files.example');
  });

  it('confirms the key the token was issued for', async () => {
    const kv = memoryKv();
    const gen = await post(brokerApp(kv, memoryBucket([])), '/generate-upload-url', {
      fileName: 'a.txt',
      contentType: 'text/plain',
      fileSize: 1,
    });
    const { uploadToken, fileKey } = (await gen.json()) as { uploadToken: string; fileKey: string };
    expect(fileKey.startsWith('workspaces/org_a/')).toBe(true);

    const res = await post(brokerApp(kv, memoryBucket([fileKey])), '/confirm-upload', { uploadToken, fileKey });
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as { file: { fileKey: string; fileSize: number } };
    expect(file).toMatchObject({ fileKey, fileSize: 42 });
  });
});

describe('GET /api/storage/public/* (local dev only)', () => {
  const app = new Hono().route('/', storageUploadTokenRoute);
  const env = { ENVIRONMENT: 'development', STORAGE: memoryBucket([VICTIM_KEY]) };

  it('serves localhost in development', async () => {
    const res = await app.request(`http://localhost:8787/api/storage/public/${VICTIM_KEY}`, {}, env);
    expect(res.status).toBe(200);
  });

  it('404s a dev server reached through any other host', async () => {
    const res = await app.request(`https://my-tunnel.example/api/storage/public/${VICTIM_KEY}`, {}, env);
    expect(res.status).toBe(404);
  });

  it('404s outside development', async () => {
    const res = await app.request(`http://localhost:8787/api/storage/public/${VICTIM_KEY}`, {}, { ...env, ENVIRONMENT: 'test' });
    expect(res.status).toBe(404);
  });
});
