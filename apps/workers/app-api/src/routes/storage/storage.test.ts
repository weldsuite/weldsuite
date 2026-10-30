/**
 * Storage upload broker hardening:
 *   - TASK-619: confirm-upload works on the token's own key, never a
 *     caller-supplied one (that was a size/URL oracle for any tenant's object).
 *   - TASK-621: upload tokens are long CSPRNG secrets, not generateId ids.
 *   - TASK-638: the dev-only public read answers localhost requests only.
 *   - Finding 665: the PUT writes exactly the declared size, once, under an
 *     allowlisted content type.
 *   - Finding 667: folder / entityType / entityId are plain path segments.
 *   - TASK-620: `isPublic` picks the bucket; private objects are readable only
 *     by a member of the key's workspace (files cookie, bearer, signed URL);
 *     `migrate-private` moves old private drive files out of the public bucket.
 *
 * Every request goes through `createTestApp` against pglite, so the same file
 * runs as the conformance suite of the Rust port (`core: storage`): the KV
 * stub and the buckets are shared with Rust over HTTP. The routes mounted
 * before Clerk (the PUT and the private read) are mounted the same way; their
 * stub session is simply never read.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageRoutes, storageUploadTokenRoute } from './index';
import { MAX_UPLOAD_BYTES } from '../../lib/storage-upload';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

// Applying every tenant migration to pglite outlasts the 10 s default hook
// timeout on a busy CI runner; the other pglite suites allow 60 s too.
beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function memoryKv() {
  const store = new Map<string, string>();
  const kv = {
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
  return Object.assign(kv, { store });
}

interface StoredObject {
  bytes: Uint8Array;
  httpMetadata?: { contentType?: string; contentDisposition?: string };
}

/** In-memory R2: `keys` are pre-existing 42-byte objects. */
function memoryBucket(keys: string[] = []) {
  const objects = new Map<string, StoredObject>(
    keys.map((key) => [key, { bytes: new Uint8Array(42) }]),
  );
  const bucket = {
    head: async (key: string) => {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength } : null;
    },
    get: async (key: string) =>
      objects.has(key)
        ? { body: 'secret', httpEtag: '"e"', writeHttpMetadata: () => {} }
        : null,
    put: async (
      key: string,
      value: Uint8Array,
      options?: {
        httpMetadata?: StoredObject['httpMetadata'];
        onlyIf?: { etagDoesNotMatch?: string };
      },
    ) => {
      // R2 `If-None-Match: *`: create only, null when the key exists.
      if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      objects.set(key, { bytes: value, httpMetadata: options?.httpMetadata });
      return { etag: `etag-${objects.size}`, size: value.byteLength };
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  } as unknown as R2Bucket;
  return Object.assign(bucket, { objects });
}

const VICTIM_KEY = 'workspaces/org_victim/uploads/general/1_x/payroll.pdf';
const CONTEXT = { userId: 'user_a', workspaceId: 'ws_a', orgId: 'org_a' };

/** The routes behind Clerk (`/api/storage/*`). */
function storageApp(env: Record<string, unknown>, context: Record<string, unknown> = {}) {
  return createTestApp('/api/storage', storageRoutes, {
    context: { ...CONTEXT, tenantDb: db, ...context },
    env: env as never,
  });
}

/** The routes mounted before Clerk (the upload PUT, the private and public reads). */
function publicApp(env: Record<string, unknown>) {
  return createTestApp('/', storageUploadTokenRoute as never, {
    context: { tenantDb: db },
    env: env as never,
  });
}

function brokerApp(kv: KVNamespace, bucket: R2Bucket) {
  return storageApp({ WORKSPACE_CACHE: kv, STORAGE: bucket, R2_PUBLIC_URL: 'https://files.example' });
}

function post(app: ReturnType<typeof brokerApp>, path: string, body: unknown) {
  return app.request(`/api/storage${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Minted {
  uploadToken: string;
  fileKey: string;
  uploadUrl: string;
}

async function mint(app: ReturnType<typeof brokerApp>, body: Record<string, unknown>): Promise<Minted> {
  const res = await post(app, '/generate-upload-url', body);
  expect(res.status).toBe(200);
  return (await res.json()) as Minted;
}

function putTo(
  kv: KVNamespace,
  bucket: R2Bucket,
  token: string,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
) {
  return publicApp({ WORKSPACE_CACHE: kv, STORAGE: bucket }).request(`/api/storage/upload/${token}`, {
    method: 'PUT',
    body,
    headers,
  });
}

const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('upload broker', () => {
  it('issues long, unguessable upload tokens', async () => {
    const app = brokerApp(memoryKv(), memoryBucket());
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
    const gen = await post(brokerApp(kv, memoryBucket()), '/generate-upload-url', {
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

  it("refuses another member's token, and a token whose object never arrived", async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const { uploadToken, fileKey } = await mint(brokerApp(kv, bucket), {
      fileName: 'a.txt',
      contentType: 'text/plain',
      fileSize: 1,
    });
    const other = storageApp({ WORKSPACE_CACHE: kv, STORAGE: bucket }, { userId: 'user_b' });
    const stolen = await post(other, '/confirm-upload', { uploadToken, fileKey });
    expect(stolen.status).toBe(400);
    expect(await stolen.json()).toEqual({ success: false, error: 'Invalid or expired upload token' });

    const missing = await post(brokerApp(kv, bucket), '/confirm-upload', { uploadToken, fileKey });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ success: false, error: 'File not found in storage' });
    // The token was spent by that attempt.
    expect(kv.store.size).toBe(0);
  });

  it('validates the confirm body', async () => {
    const res = await post(brokerApp(memoryKv(), memoryBucket()), '/confirm-upload', { uploadToken: '', etag: 4 });
    expect(res.status).toBe(400);
  });

  it('needs a signed-in member of a workspace', async () => {
    const body = { fileName: 'a.txt', contentType: 'text/plain', fileSize: 1 };
    const env = { WORKSPACE_CACHE: memoryKv(), STORAGE: memoryBucket() };
    const anonymous = await post(storageApp(env, { userId: '' }), '/generate-upload-url', body);
    expect(anonymous.status).toBe(401);
    const noOrg = await post(storageApp(env, { orgId: null }), '/generate-upload-url', body);
    expect(noOrg.status).toBe(400);
    expect(((await noOrg.json()) as { error: { code: string } }).error.code).toBe('ORG_REQUIRED');
  });
});

describe('PUT /api/storage/upload/:token (finding 665)', () => {
  const declare = { fileName: 'a.bin', contentType: 'image/png', fileSize: 5 };

  it('writes the declared bytes, and confirm-upload still works afterwards', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const app = brokerApp(kv, bucket);
    const { uploadToken, fileKey } = await mint(app, declare);

    const put = await putTo(kv, bucket, uploadToken, bytesOf(5), { 'Content-Length': '5' });
    expect(put.status).toBe(200);
    expect(put.headers.get('ETag')).toBeTruthy();
    expect(bucket.objects.get(fileKey)?.bytes.byteLength).toBe(5);

    const confirm = await post(app, '/confirm-upload', { uploadToken, fileKey });
    expect(confirm.status).toBe(200);
    const { file } = (await confirm.json()) as { file: { fileKey: string; fileSize: number; mimeType: string } };
    expect(file).toMatchObject({ fileKey, fileSize: 5, mimeType: 'image/png' });
  });

  it('accepts an empty file declared as 0 bytes', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const { uploadToken, fileKey } = await mint(brokerApp(kv, bucket), { ...declare, fileSize: 0 });
    const put = await putTo(kv, bucket, uploadToken, '');
    expect(put.status).toBe(200);
    expect(bucket.objects.get(fileKey)?.bytes.byteLength).toBe(0);
  });

  it('rejects a body shorter than declared, stores nothing, and keeps the token usable', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const { uploadToken, fileKey } = await mint(brokerApp(kv, bucket), declare);

    const short = await putTo(kv, bucket, uploadToken, bytesOf(3));
    expect(short.status).toBe(400);
    expect(bucket.objects.has(fileKey)).toBe(false);

    const retry = await putTo(kv, bucket, uploadToken, bytesOf(5));
    expect(retry.status).toBe(200);
  });

  it('rejects a body longer than declared, stores nothing', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const { uploadToken, fileKey } = await mint(brokerApp(kv, bucket), declare);

    const res = await putTo(kv, bucket, uploadToken, bytesOf(6));
    expect(res.status).toBe(413);
    expect(bucket.objects.has(fileKey)).toBe(false);
  });

  it('refuses on Content-Length alone, before reading the body', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const { uploadToken, fileKey } = await mint(brokerApp(kv, bucket), declare);
    // A Content-Length that disagrees with the body can't be sent over a real
    // connection (fetch refuses it, and a proxy that parses HTTP drops it), so
    // this one runs on the Hono app only; the Rust port checks the same header
    // in its own tests.
    const testApp = publicApp({ WORKSPACE_CACHE: kv, STORAGE: bucket });
    const put = (contentLength: string) =>
      testApp.app.request(
        `/api/storage/upload/${uploadToken}`,
        { method: 'PUT', body: bytesOf(5), headers: { 'Content-Length': contentLength } },
        testApp.env as never,
        testApp.executionCtx,
      );

    expect((await put('9999999')).status).toBe(413);
    expect((await put('2')).status).toBe(400);
    expect((await put('abc')).status).toBe(400);
    expect(bucket.objects.has(fileKey)).toBe(false);
  });

  it('refuses to mint a token above the hard cap', async () => {
    const kv = memoryKv();
    const res = await post(brokerApp(kv, memoryBucket()), '/generate-upload-url', {
      ...declare,
      fileSize: MAX_UPLOAD_BYTES + 1,
    });
    expect(res.status).toBe(400);
    expect(kv.store.size).toBe(0);
  });

  it('refuses a token minted before the cap with a larger declared size', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    kv.store.set(
      'upload:upl_legacy',
      JSON.stringify({
        fileKey: 'workspaces/org_a/uploads/general/1_x/big.bin',
        contentType: 'application/pdf',
        fileName: 'big.bin',
        fileSize: MAX_UPLOAD_BYTES + 1,
        isPublic: false,
        userId: 'user_a',
        createdAt: Date.now(),
      }),
    );
    const res = await putTo(kv, bucket, 'upl_legacy', bytesOf(1));
    expect(res.status).toBe(413);
  });

  it('is single-use: a second PUT with the same token is refused and changes nothing', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const { uploadToken, fileKey } = await mint(brokerApp(kv, bucket), declare);

    expect((await putTo(kv, bucket, uploadToken, bytesOf(5, 1))).status).toBe(200);
    const replay = await putTo(kv, bucket, uploadToken, bytesOf(5, 2));
    expect(replay.status).toBe(409);
    expect(bucket.objects.get(fileKey)?.bytes[0]).toBe(1);
  });

  it('cannot overwrite after confirm-upload', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const app = brokerApp(kv, bucket);
    const { uploadToken, fileKey } = await mint(app, declare);

    expect((await putTo(kv, bucket, uploadToken, bytesOf(5, 1))).status).toBe(200);
    expect((await post(app, '/confirm-upload', { uploadToken, fileKey })).status).toBe(200);

    const replay = await putTo(kv, bucket, uploadToken, bytesOf(5, 2));
    expect(replay.status).toBe(400);
    expect(bucket.objects.get(fileKey)?.bytes[0]).toBe(1);
  });

  it('holds even when the KV flag is not visible yet (R2 create-only precondition)', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const { uploadToken, fileKey } = await mint(brokerApp(kv, bucket), declare);
    const kvKey = `upload:${uploadToken}`;
    const beforePut = kv.store.get(kvKey) as string;

    expect((await putTo(kv, bucket, uploadToken, bytesOf(5, 1))).status).toBe(200);
    // A stale KV read in another location still shows the unflagged record.
    kv.store.set(kvKey, beforePut);

    const replay = await putTo(kv, bucket, uploadToken, bytesOf(5, 2));
    expect(replay.status).toBe(409);
    expect(bucket.objects.get(fileKey)?.bytes[0]).toBe(1);
  });

  it('still lets an avatar be replaced through a fresh token (deterministic key)', async () => {
    const kv = memoryKv();
    const bucket = memoryBucket();
    const app = brokerApp(kv, bucket);
    const avatar = { fileName: 'me.png', contentType: 'image/png', fileSize: 5, entityType: 'customer-avatar', entityId: 'cust_1' };

    const first = await mint(app, avatar);
    const second = await mint(app, avatar);
    expect(first.fileKey).toBe('workspaces/org_a/avatars/customers/cust_1/logo.png');
    expect(second.fileKey).toBe(first.fileKey);

    expect((await putTo(kv, bucket, first.uploadToken, bytesOf(5, 1))).status).toBe(200);
    expect((await putTo(kv, bucket, second.uploadToken, bytesOf(5, 2))).status).toBe(200);
    expect(bucket.objects.get(first.fileKey)?.bytes[0]).toBe(2);

    // Replaceable key, but each token still writes only once (the KV flag is
    // the only guard here: there is no create-only precondition on these keys).
    expect((await putTo(kv, bucket, first.uploadToken, bytesOf(5, 3))).status).toBe(409);
    expect(bucket.objects.get(first.fileKey)?.bytes[0]).toBe(2);
  });

  it('rejects an unknown token', async () => {
    const res = await putTo(memoryKv(), memoryBucket(), 'upl_nope', bytesOf(1));
    expect(res.status).toBe(400);
  });

  it('answers 500 when the bucket the token names is not bound', async () => {
    const kv = memoryKv();
    const { uploadToken } = await mint(
      storageApp({ WORKSPACE_CACHE: kv, STORAGE: memoryBucket(), PRIVATE_STORAGE: memoryBucket() }),
      declare,
    );
    // Minted for the private bucket, redeemed where only the public one is bound.
    const res = await putTo(kv, memoryBucket(), uploadToken, bytesOf(5));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Storage is not configured' });
  });

  describe('content type', () => {
    async function storedAs(contentType: string, putHeaders: Record<string, string> = {}) {
      const kv = memoryKv();
      const bucket = memoryBucket();
      const app = brokerApp(kv, bucket);
      const { uploadToken, fileKey } = await mint(app, { fileName: 'f.bin', contentType, fileSize: 3 });
      expect((await putTo(kv, bucket, uploadToken, bytesOf(3), putHeaders)).status).toBe(200);
      const confirm = await post(app, '/confirm-upload', { uploadToken, fileKey });
      const { file } = (await confirm.json()) as { file: { mimeType: string } };
      return { stored: bucket.objects.get(fileKey)?.httpMetadata, mimeType: file.mimeType };
    }

    it.each([
      'text/html',
      'text/html; charset=utf-8',
      'TEXT/HTML',
      'image/svg+xml',
      'application/xhtml+xml',
      'application/xml',
      'text/xml',
      'text/javascript',
      'application/javascript',
      'text/css',
      'application/x-shockwave-flash',
      'text/html\r\nX-Evil: 1',
      'not a media type',
    ])('stores %j as an attachment octet-stream', async (declared) => {
      const { stored, mimeType } = await storedAs(declared);
      expect(stored).toEqual({ contentType: 'application/octet-stream', contentDisposition: 'attachment' });
      expect(mimeType).toBe('application/octet-stream');
    });

    it.each([
      ['image/png', 'image/png'],
      ['image/jpeg', 'image/jpeg'],
      ['application/pdf', 'application/pdf'],
      ['text/plain', 'text/plain'],
      ['video/webm;codecs=vp9,opus', 'video/webm'],
      ['audio/mpeg', 'audio/mpeg'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ])('keeps %j as %j, inline', async (declared, expected) => {
      const { stored, mimeType } = await storedAs(declared);
      expect(stored).toEqual({ contentType: expected });
      expect(mimeType).toBe(expected);
    });

    it("ignores the PUT's own Content-Type header", async () => {
      const { stored } = await storedAs('image/png', { 'Content-Type': 'text/html' });
      expect(stored).toEqual({ contentType: 'image/png' });
    });
  });
});

describe('POST /generate-upload-url key hardening (finding 667)', () => {
  const base = { fileName: 'a.txt', contentType: 'text/plain', fileSize: 1 };

  async function attempt(extra: Record<string, unknown>) {
    const kv = memoryKv();
    const res = await post(brokerApp(kv, memoryBucket()), '/generate-upload-url', { ...base, ...extra });
    return { res, kv };
  }

  it.each([
    '..',
    '.',
    '../org_victim',
    'a/../b',
    'a/./b',
    '/abs',
    'a/',
    'a//b',
    'a.b',
    'a\\b',
    '%2e%2e',
    'a%2fb',
    'a b',
    'A',
    'a/b/c/d',
    'x'.repeat(49),
    '..%2f..',
  ])('rejects folder %j', async (folder) => {
    const { res, kv } = await attempt({ folder });
    expect(res.status).toBe(400);
    expect(kv.store.size).toBe(0);
  });

  it.each(['..', '.', 'a/b', '../x', 'a.b', 'a b', '%2e%2e', 'x'.repeat(49), 'Customer'])(
    'rejects entityType %j',
    async (entityType) => {
      const { res, kv } = await attempt({ entityType, entityId: 'id_1' });
      expect(res.status).toBe(400);
      expect(kv.store.size).toBe(0);
    },
  );

  it.each(['..', '.', '../org_victim', 'a/b', 'a.b', 'a b', 'a\\b', '%2e%2e', 'x'.repeat(65), '\n'])(
    'rejects entityId %j',
    async (entityId) => {
      const { res, kv } = await attempt({ entityType: 'task', entityId });
      expect(res.status).toBe(400);
      expect(kv.store.size).toBe(0);
    },
  );

  it.each(['customer-avatar', 'contact-avatar', 'user-app-logo'])(
    'rejects a hostile entityId on the %s branch',
    async (entityType) => {
      const { res, kv } = await attempt({ entityType, entityId: '../../org_victim/avatars/x' });
      expect(res.status).toBe(400);
      expect(kv.store.size).toBe(0);
    },
  );

  it('rejects an over-long file name', async () => {
    const { res } = await attempt({ fileName: `${'a'.repeat(256)}.txt` });
    expect(res.status).toBe(400);
  });

  it('reports every bad field, as Zod orders them', async () => {
    const { res } = await attempt({ fileName: '', contentType: 5, fileSize: 1.5, folder: 'A', entityType: 3, entityId: '..', isPublic: 'x' });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { issues: Array<{ path: string[] }> } };
    expect(error.issues.map((issue) => issue.path[0])).toEqual([
      'fileName', 'contentType', 'fileSize', 'isPublic', 'entityType', 'folder', 'entityId',
    ]);
  });

  it.each([
    ['avatars', 'person-avatar', 'person_lx3k9abc12'],
    ['documents/content', 'project-document', 'proj_1-2'],
    ['weldbooks/documents', 'accounting_document', undefined],
    ['projects', 'task', '0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['mail-attachments', 'mail-attachment', 'org_2AbC'],
    [undefined, undefined, undefined],
  ])('accepts folder=%s entityType=%s entityId=%s', async (folder, entityType, entityId) => {
    const { res } = await attempt({ folder, entityType, entityId });
    expect(res.status).toBe(200);
  });

  it('treats empty strings as absent (block editor sends entityId "")', async () => {
    const { res } = await attempt({ folder: '', entityType: '', entityId: '' });
    expect(res.status).toBe(200);
    const { fileKey } = (await res.json()) as { fileKey: string };
    expect(fileKey).toMatch(/^workspaces\/org_a\/uploads\/general\/\d+_[0-9a-f]{32}\/a\.txt$/);
  });

  it('keeps the key shape the project-files check relies on', async () => {
    const { res } = await attempt({ folder: 'projects', entityType: 'project', entityId: 'proj_1' });
    const { fileKey } = (await res.json()) as { fileKey: string };
    expect(fileKey).toMatch(/^workspaces\/org_a\/projects\/project\/proj_1\/\d+_[0-9a-f]{32}\/a\.txt$/);
  });

  it('never lets the file name escape its directory', async () => {
    const dots = await attempt({ fileName: '..' });
    expect(((await dots.res.json()) as { fileKey: string }).fileKey).toMatch(/\/file$/);
    const slashes = await attempt({ fileName: '../../x/y.txt' });
    const { fileKey } = (await slashes.res.json()) as { fileKey: string };
    expect(fileKey).toMatch(/\/\.\._\.\._x_y\.txt$/);
    expect(fileKey.split('/').filter((s) => s === '..' || s === '.')).toEqual([]);
  });

  it('sanitises the extension of the fixed-key avatar branches', async () => {
    const hostile = await attempt({
      fileName: 'x.png/../../../org_victim/avatars/a',
      entityType: 'customer-avatar',
      entityId: 'cust_1',
    });
    expect(((await hostile.res.json()) as { fileKey: string }).fileKey).toBe(
      'workspaces/org_a/avatars/customers/cust_1/logo.png',
    );
    const noDot = await attempt({ fileName: 'avatar', entityType: 'contact-avatar', entityId: 'c_1' });
    expect(((await noDot.res.json()) as { fileKey: string }).fileKey).toBe(
      'workspaces/org_a/avatars/contacts/c_1/logo.png',
    );
    const webp = await attempt({ fileName: 'Me.WEBP', entityType: 'user-app-logo', entityId: 'app_1' });
    expect(((await webp.res.json()) as { fileKey: string }).fileKey).toBe(
      'workspaces/org_a/user-apps/app_1/logo.webp',
    );
  });
});

describe('GET /api/storage/public/* (local dev only)', () => {
  const env = () => ({ ENVIRONMENT: 'development', STORAGE: memoryBucket([VICTIM_KEY]) });

  it('serves localhost in development', async () => {
    const res = await publicApp(env()).request(`http://localhost:8787/api/storage/public/${VICTIM_KEY}`);
    expect(res.status).toBe(200);
  });

  it('404s a dev server reached through any other host', async () => {
    const res = await publicApp(env()).request(`https://my-tunnel.example/api/storage/public/${VICTIM_KEY}`);
    expect(res.status).toBe(404);
  });

  it('404s outside development', async () => {
    const res = await publicApp({ ...env(), ENVIRONMENT: 'test' }).request(
      `http://localhost:8787/api/storage/public/${VICTIM_KEY}`,
    );
    expect(res.status).toBe(404);
  });

  it('answers a missing object with a 404 and a traversal with a 400', async () => {
    const app = publicApp(env());
    expect((await app.request('http://localhost:8787/api/storage/public/workspaces/org_a/none.png')).status).toBe(404);
    expect((await app.request('http://localhost:8787/api/storage/public/workspaces/..%2Fx/y')).status).toBe(400);
  });
});

// ============================================================================
// TASK-620: public vs private bucket, and the private read route
// ============================================================================

const API = 'https://app-api.example';
const SIGNING_KEY = 'test-signing-key';
const OWN_KEY = 'workspaces/org_a/drive/general/1_y/payroll.pdf';

/** Session tokens the routes verify themselves: a key pair of the test's own. */
const clerkKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLERK_JWT_KEY = clerkKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function sessionToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const signed = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now, exp: now + 600, ...claims })}`;
  const signature = createSign('RSA-SHA256').update(signed).sign(clerkKeys.privateKey).toString('base64url');
  return `${signed}.${signature}`;
}

/** In-memory R2 that keeps content type and custom metadata, for reads. */
function richBucket(initial: Record<string, { body: string; contentType: string }> = {}) {
  const objects = new Map<string, { body: string; contentType: string; fileName?: string }>(Object.entries(initial));
  const toObject = (key: string) => {
    const o = objects.get(key)!;
    return {
      key,
      size: o.body.length,
      body: o.body,
      httpEtag: '"e"',
      customMetadata: o.fileName ? { fileName: o.fileName } : {},
      writeHttpMetadata: (h: Headers) => h.set('content-type', o.contentType),
    };
  };
  const bucket = {
    head: async (key: string) => (objects.has(key) ? toObject(key) : null),
    get: async (key: string) => (objects.has(key) ? toObject(key) : null),
    put: async (
      key: string,
      value: Uint8Array | string,
      opts?: { httpMetadata?: { contentType?: string }; customMetadata?: { fileName?: string } },
    ) => {
      objects.set(key, {
        // `migrate-private` copies another object's body, which is a string here.
        body: typeof value === 'string' ? value : new TextDecoder().decode(value),
        contentType: opts?.httpMetadata?.contentType ?? 'application/octet-stream',
        fileName: opts?.customMetadata?.fileName,
      });
      return { etag: 'etag-1' };
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return Object.assign(bucket as unknown as R2Bucket, { objects });
}

interface Buckets {
  STORAGE: ReturnType<typeof richBucket>;
  PRIVATE_STORAGE?: ReturnType<typeof richBucket>;
}

function splitApp(kv: KVNamespace, buckets: Buckets, extraEnv: Record<string, unknown> = {}) {
  return storageApp({
    WORKSPACE_CACHE: kv,
    R2_PUBLIC_URL: 'https://files.example',
    STORAGE_SIGNING_KEY: SIGNING_KEY,
    ...buckets,
    ...extraEnv,
  });
}

function postTo(app: ReturnType<typeof splitApp>, path: string, body: unknown) {
  return app.request(`${API}/api/storage${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Generate → PUT → confirm, returning what confirm-upload hands back. */
async function uploadThrough(buckets: Buckets, input: Record<string, unknown>) {
  const kv = memoryKv();
  const app = splitApp(kv, buckets);
  const gen = await postTo(app, '/generate-upload-url', {
    fileName: 'payroll.pdf',
    contentType: 'application/pdf',
    fileSize: 6,
    ...input,
  });
  expect(gen.status).toBe(200);
  const { uploadToken, fileKey, uploadUrl } = (await gen.json()) as Minted;
  const put = await publicApp({ WORKSPACE_CACHE: kv, ...buckets }).request(uploadUrl, { method: 'PUT', body: 'secret' });
  expect(put.status).toBe(200);
  const res = await postTo(app, '/confirm-upload', { uploadToken, fileKey });
  expect(res.status).toBe(200);
  return ((await res.json()) as { file: { fileKey: string; url: string; isPublic: boolean; bucket: string } }).file;
}

describe('isPublic picks the bucket (TASK-620)', () => {
  it('puts a private upload in the private bucket, behind an app-api URL', async () => {
    const buckets = { STORAGE: richBucket(), PRIVATE_STORAGE: richBucket() };
    const file = await uploadThrough(buckets, {});
    expect(file).toMatchObject({ isPublic: false, bucket: 'private' });
    expect(file.url).toBe(`${API}/api/storage/private/${file.fileKey}`);
    expect(buckets.PRIVATE_STORAGE.objects.has(file.fileKey)).toBe(true);
    expect(buckets.STORAGE.objects.size).toBe(0);
  });

  it('puts a public upload on the public domain', async () => {
    const buckets = { STORAGE: richBucket(), PRIVATE_STORAGE: richBucket() };
    const file = await uploadThrough(buckets, { isPublic: true });
    expect(file).toMatchObject({ isPublic: true, bucket: 'public' });
    expect(file.url).toBe(`https://files.example/${file.fileKey}`);
    expect(buckets.PRIVATE_STORAGE.objects.size).toBe(0);
  });

  it('keeps avatars and app logos public whatever isPublic says', async () => {
    for (const entityType of ['customer-avatar', 'contact-avatar', 'user-app-logo']) {
      const buckets = { STORAGE: richBucket(), PRIVATE_STORAGE: richBucket() };
      const file = await uploadThrough(buckets, {
        entityType,
        entityId: 'x1',
        fileName: 'logo.png',
        contentType: 'image/png',
        isPublic: false,
      });
      expect(file.bucket).toBe('public');
    }
  });

  it('refuses a private upload in production without the private bucket', async () => {
    const app = splitApp(memoryKv(), { STORAGE: richBucket() }, { ENVIRONMENT: 'production' });
    const res = await postTo(app, '/generate-upload-url', { fileName: 'a.pdf', contentType: 'application/pdf', fileSize: 1 });
    expect(res.status).toBe(503);
  });

  it('falls back to the public bucket outside production without the private bucket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await uploadThrough({ STORAGE: richBucket() }, {});
    warn.mockRestore();
    expect(file.bucket).toBe('public');
  });

  it('serves a public upload on localhost through the local read', async () => {
    const kv = memoryKv();
    const buckets = { STORAGE: richBucket() };
    const app = storageApp({ WORKSPACE_CACHE: kv, R2_PUBLIC_URL: 'https://files.example', ...buckets });
    const gen = await app.request('http://localhost:8787/api/storage/generate-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'logo.png', contentType: 'image/png', fileSize: 6, isPublic: true }),
    });
    const { uploadToken, fileKey, uploadUrl } = (await gen.json()) as Minted;
    expect(uploadUrl).toBe(`http://localhost:8787/api/storage/upload/${uploadToken}`);
    const put = await publicApp({ WORKSPACE_CACHE: kv, ...buckets }).request(uploadUrl, { method: 'PUT', body: 'pixels' });
    expect(put.status).toBe(200);
    const confirm = await app.request('http://localhost:8787/api/storage/confirm-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadToken, fileKey }),
    });
    const { file } = (await confirm.json()) as { file: { url: string } };
    expect(file.url).toBe(`http://localhost:8787/api/storage/public/${fileKey}`);
  });
});

describe('GET /api/storage/private/* (TASK-620)', () => {
  const env = () => ({
    STORAGE_SIGNING_KEY: SIGNING_KEY,
    CLERK_SECRET_KEY: 'sk_test',
    CLERK_JWT_KEY,
    PRIVATE_STORAGE: richBucket({
      [OWN_KEY]: { body: 'secret', contentType: 'application/pdf' },
      [VICTIM_KEY]: { body: 'secret', contentType: 'application/pdf' },
    }),
  });
  const url = (key: string) => `${API}/api/storage/private/${key}`;
  const read = (target: string, init: RequestInit = {}, readEnv: Record<string, unknown> = env()) =>
    publicApp(readEnv).request(target, init);

  async function filesCookie(orgId = 'org_a') {
    const app = storageApp({ STORAGE_SIGNING_KEY: SIGNING_KEY }, { orgId });
    const res = await app.request(`${API}/api/storage/access`, { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain(`Path=/api/storage/private/workspaces/${orgId}/`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    return setCookie.split(';')[0]!;
  }

  it('401s without any credential', async () => {
    expect((await read(url(OWN_KEY))).status).toBe(401);
  });

  it("serves the caller's workspace with its files cookie", async () => {
    const res = await read(url(OWN_KEY), { headers: { Cookie: await filesCookie() } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('secret');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
  });

  it("404s another workspace's key with a valid cookie", async () => {
    const res = await read(url(VICTIM_KEY), { headers: { Cookie: await filesCookie() } });
    expect(res.status).toBe(404);
  });

  it('404s a forged or expired cookie', async () => {
    const forged = (await filesCookie()).replace(/\.[^.]+$/, '.forged');
    expect((await read(url(OWN_KEY), { headers: { Cookie: forged } })).status).toBe(404);
    expect((await read(url(OWN_KEY), { headers: { Cookie: 'ws_files=v1.org_a.1.x' } })).status).toBe(404);
  });

  it('accepts a bearer token for the same workspace only, from an authorized party', async () => {
    const as = (jwt: string) => read(url(OWN_KEY), { headers: { Authorization: `Bearer ${jwt}` } });
    expect((await as(sessionToken({ sub: 'user_a', o: { id: 'org_a' } }))).status).toBe(200);
    expect((await as(sessionToken({ sub: 'user_a', org_id: 'org_a' }))).status).toBe(200);
    expect((await as(sessionToken({ sub: 'user_b', o: { id: 'org_b' } }))).status).toBe(404);
    expect((await as(sessionToken({ sub: 'user_a', o: { id: 'org_a' }, azp: 'https://evil.example' }))).status).toBe(404);
    expect((await as(sessionToken({ sub: 'user_a', o: { id: 'org_a' }, exp: 1 }))).status).toBe(404);
    expect((await as('forged')).status).toBe(404);
  });

  it('serves a signed URL for its own key only', async () => {
    const app = splitApp(memoryKv(), { STORAGE: richBucket() });
    const res = await postTo(app, '/sign', { files: [url(OWN_KEY), VICTIM_KEY] });
    const { data } = (await res.json()) as { data: Record<string, { url: string }> };
    expect(Object.keys(data)).toEqual([url(OWN_KEY)]);

    const signed = data[url(OWN_KEY)]!.url;
    expect((await read(signed)).status).toBe(200);
    const sig = new URL(signed).search;
    expect((await read(`${url(VICTIM_KEY)}${sig}`)).status).toBe(404);
  });

  it('signs bare keys too, for the requested lifetime', async () => {
    const app = splitApp(memoryKv(), { STORAGE: richBucket() });
    const res = await postTo(app, '/sign', { files: [OWN_KEY, '../etc/passwd'], ttlSeconds: 60 });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, { url: string; expiresAt: number }> };
    expect(Object.keys(data)).toEqual([OWN_KEY]);
    const { expiresAt } = data[OWN_KEY]!;
    expect(Math.abs(expiresAt - Math.floor(Date.now() / 1000) - 60)).toBeLessThanOrEqual(2);
    expect((await read(data[OWN_KEY]!.url)).status).toBe(200);
  });

  it('never renders active content inline', async () => {
    const key = 'workspaces/org_a/x/1_z/page.html';
    const res = await read(
      url(key),
      { headers: { Authorization: `Bearer ${sessionToken({ sub: 'user_a', o: { id: 'org_a' } })}` } },
      { ...env(), PRIVATE_STORAGE: richBucket({ [key]: { body: '<script>', contentType: 'text/html' } }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects traversal in the key', async () => {
    const res = await read(`${API}/api/storage/private/workspaces/org_a/..%2Forg_victim/uploads/x`, {
      headers: { Authorization: `Bearer ${sessionToken({ sub: 'user_a', o: { id: 'org_a' } })}` },
    });
    expect(res.status).toBe(404);
  });

  it('404s an unknown key of the caller\'s own workspace', async () => {
    const res = await read(url('workspaces/org_a/drive/none.pdf'), { headers: { Cookie: await filesCookie() } });
    expect(res.status).toBe(404);
  });
});

describe('POST|DELETE /api/storage/access and POST /sign refusals', () => {
  it('answers 503 without a signing key', async () => {
    const app = storageApp({});
    expect((await app.request(`${API}/api/storage/access`, { method: 'POST' })).status).toBe(503);
    const sign = await postTo(app, '/sign', { files: [OWN_KEY] });
    expect(sign.status).toBe(503);
  });

  it('needs a workspace', async () => {
    const app = storageApp({ STORAGE_SIGNING_KEY: SIGNING_KEY }, { orgId: null });
    expect((await app.request(`${API}/api/storage/access`, { method: 'POST' })).status).toBe(400);
    expect((await app.request(`${API}/api/storage/access`, { method: 'DELETE' })).status).toBe(400);
  });

  it('drops the files cookie on DELETE', async () => {
    const res = await storageApp({}).request(`${API}/api/storage/access`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie')).toBe(
      'ws_files=; Path=/api/storage/private/workspaces/org_a/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
  });

  it('validates the sign body', async () => {
    const app = storageApp({ STORAGE_SIGNING_KEY: SIGNING_KEY });
    expect((await postTo(app, '/sign', { files: [] })).status).toBe(400);
    expect((await postTo(app, '/sign', { files: [OWN_KEY], ttlSeconds: 10 })).status).toBe(400);
  });
});

// ============================================================================
// POST /api/storage/migrate-private
// ============================================================================

describe('POST /api/storage/migrate-private (TASK-620)', () => {
  const ADMIN = { permissions: permissions('settings:general:update') };

  async function seedFile(id: string, values: Partial<typeof schema.files.$inferInsert> = {}) {
    const now = new Date('2026-10-01T10:00:00.000Z');
    await db.insert(schema.files).values({
      id,
      fileName: `${id}.pdf`,
      mimeType: 'application/pdf',
      fileSize: 6,
      storagePath: `workspaces/org_a/drive/${id}.pdf`,
      fileKey: `workspaces/org_a/drive/${id}.pdf`,
      url: `https://files.example/workspaces/org_a/drive/${id}.pdf`,
      createdAt: now,
      updatedAt: now,
      ...values,
    } as typeof schema.files.$inferInsert);
  }

  beforeEach(async () => {
    await db.delete(schema.files);
  });

  function migrate(buckets: Partial<Buckets>, body: Record<string, unknown> = {}, context = ADMIN) {
    return postTo(storageApp({ ...buckets }, context), '/migrate-private', body);
  }

  it('needs settings:general:update', async () => {
    const res = await migrate({ STORAGE: richBucket(), PRIVATE_STORAGE: richBucket() }, {}, {
      permissions: permissions('files:read'),
    });
    expect(res.status).toBe(403);
  });

  it('needs both buckets', async () => {
    expect((await migrate({ STORAGE: richBucket() })).status).toBe(503);
  });

  it('validates its body', async () => {
    expect((await migrate({ STORAGE: richBucket(), PRIVATE_STORAGE: richBucket() }, { cursor: 4 })).status).toBe(400);
  });

  it('moves private drive files, repoints those already moved, and skips the rest', async () => {
    const pub = richBucket({
      'workspaces/org_a/drive/file_a.pdf': { body: 'aaaaaa', contentType: 'application/pdf' },
      'workspaces/org_a/drive/file_b.pdf': { body: 'bbbbbb', contentType: 'application/pdf' },
    });
    const priv = richBucket({ 'workspaces/org_a/drive/file_b.pdf': { body: 'bbbbbb', contentType: 'application/pdf' } });
    await seedFile('file_a');
    await seedFile('file_b');
    await seedFile('file_c'); // no object anywhere
    await seedFile('file_d', { fileKey: 'workspaces/org_other/drive/d.pdf' });
    await seedFile('file_e', { fileKey: null, storagePath: '' });
    await seedFile('file_f', { isPublic: true });
    await seedFile('file_g', { entityType: 'ticket' });
    await seedFile('file_h', { url: `${API}/api/storage/private/workspaces/org_a/drive/file_h.pdf` });

    const dry = await migrate({ STORAGE: pub, PRIVATE_STORAGE: priv }, { dryRun: true });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { data: unknown }).data).toEqual({
      moved: 1,
      repointed: 1,
      skipped: [
        { id: 'file_c', reason: 'missing-object' },
        { id: 'file_d', reason: 'foreign-key' },
        { id: 'file_e', reason: 'no-key' },
      ],
      updated: [],
      cursor: null,
      done: true,
    });
    expect(pub.objects.size).toBe(2);

    const res = await migrate({ STORAGE: pub, PRIVATE_STORAGE: priv }, {});
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { moved: number; repointed: number; updated: Array<{ id: string; url: string }> };
    };
    expect(data).toMatchObject({ moved: 1, repointed: 1 });
    expect(data.updated.map((f) => f.id)).toEqual(['file_a', 'file_b']);
    expect(data.updated[0]!.url).toBe(`${API}/api/storage/private/workspaces/org_a/drive/file_a.pdf`);
    expect(priv.objects.get('workspaces/org_a/drive/file_a.pdf')?.body).toBe('aaaaaa');
    expect(pub.objects.size).toBe(0);
    const rows = await db.select().from(schema.files);
    const moved = rows.find((row) => row.id === 'file_a')!;
    expect(moved).toMatchObject({ bucket: 'private', url: data.updated[0]!.url });

    // Nothing left to move.
    const again = await migrate({ STORAGE: pub, PRIVATE_STORAGE: priv }, {});
    expect(((await again.json()) as { data: { moved: number; repointed: number } }).data).toMatchObject({
      moved: 0,
      repointed: 0,
    });
  });

  it('pages by id and hands back a cursor', async () => {
    for (let i = 0; i < 26; i++) await seedFile(`file_${String(i).padStart(2, '0')}`);
    const buckets = { STORAGE: richBucket(), PRIVATE_STORAGE: richBucket() };
    const first = await migrate(buckets, { dryRun: true });
    const page = ((await first.json()) as { data: { cursor: string | null; done: boolean; skipped: unknown[] } }).data;
    expect(page).toMatchObject({ cursor: 'file_24', done: false });
    expect(page.skipped).toHaveLength(25);
    const second = await migrate(buckets, { dryRun: true, cursor: page.cursor });
    expect(((await second.json()) as { data: unknown }).data).toMatchObject({ cursor: null, done: true });
  });
});
