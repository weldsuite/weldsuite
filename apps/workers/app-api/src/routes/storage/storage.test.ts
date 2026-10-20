/**
 * Storage upload broker hardening:
 *   - TASK-619: confirm-upload works on the token's own key, never a
 *     caller-supplied one (that was a size/URL oracle for any tenant's object).
 *   - TASK-621: upload tokens are long CSPRNG secrets, not generateId ids.
 *   - TASK-638: the dev-only public read answers localhost requests only.
 *   - Finding 665: the PUT writes exactly the declared size, once, under an
 *     allowlisted content type.
 *   - Finding 667: folder / entityType / entityId are plain path segments.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { storageRoutes, storageUploadTokenRoute } from './index';
import { MAX_UPLOAD_BYTES } from '../../lib/storage-upload';
import { createTestApp } from '@weldsuite/worker-kit/testing';

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
  } as unknown as R2Bucket;
  return Object.assign(bucket, { objects });
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
  const app = new Hono().route('/', storageUploadTokenRoute);
  return app.request(
    `/api/storage/upload/${token}`,
    { method: 'PUT', body, headers },
    { WORKSPACE_CACHE: kv, STORAGE: bucket },
  );
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

  it('rejects a body longer than declared (no Content-Length), stores nothing', async () => {
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

    const tooBig = await putTo(kv, bucket, uploadToken, bytesOf(5), { 'Content-Length': '9999999' });
    expect(tooBig.status).toBe(413);
    const tooSmall = await putTo(kv, bucket, uploadToken, bytesOf(5), { 'Content-Length': '2' });
    expect(tooSmall.status).toBe(400);
    const garbage = await putTo(kv, bucket, uploadToken, bytesOf(5), { 'Content-Length': 'abc' });
    expect(garbage.status).toBe(400);
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
