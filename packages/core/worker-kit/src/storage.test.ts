import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cookieValues,
  deleteStoredObject,
  filesCookiePath,
  getStoredObject,
  isInlineSafeContentType,
  isSafeObjectKey,
  isWorkspaceObjectKey,
  keyFromPrivateObjectUrl,
  locateStoredObject,
  privateObjectUrl,
  putStoredObject,
  signFilesCookie,
  signPrivateObjectUrl,
  verifyFilesCookie,
  verifyPrivateObjectSignature,
  workspaceOfKey,
} from './storage';

const SECRET = 'test-signing-key';
const KEY = 'workspaces/org_a/drive/general/1_abc/report final.pdf';

function memoryBucket(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const bucket = {
    objects,
    get: async (key: string) =>
      objects.has(key) ? { key, body: objects.get(key), httpEtag: '"e"', writeHttpMetadata: () => {} } : null,
    head: async (key: string) => (objects.has(key) ? { key, size: objects.get(key)!.length } : null),
    put: async (key: string, body: string) => {
      objects.set(key, body);
      return { key };
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  };
  return bucket as typeof bucket & R2Bucket;
}

afterEach(() => vi.useRealTimers());

describe('keys and URLs', () => {
  it('reads the workspace from a key', () => {
    expect(workspaceOfKey(KEY)).toBe('org_a');
    expect(workspaceOfKey('avatars/x.png')).toBeNull();
    expect(workspaceOfKey('workspaces/../x')).toBeNull();
  });

  it('rejects traversal and empty segments', () => {
    expect(isSafeObjectKey(KEY)).toBe(true);
    expect(isSafeObjectKey('/workspaces/org_a/x')).toBe(false);
    expect(isSafeObjectKey('workspaces/org_a/../org_b/x')).toBe(false);
    expect(isSafeObjectKey('workspaces//x')).toBe(false);
  });

  it('accepts only safe keys of the given workspaces', () => {
    expect(isWorkspaceObjectKey(KEY, 'org_a')).toBe(true);
    expect(isWorkspaceObjectKey(KEY, null, undefined, 'ws_a', 'org_a')).toBe(true);
    expect(isWorkspaceObjectKey(KEY, 'org_b')).toBe(false);
    expect(isWorkspaceObjectKey(KEY)).toBe(false);
    expect(isWorkspaceObjectKey(KEY, null, undefined)).toBe(false);
    expect(isWorkspaceObjectKey('workspaces/org_a/../org_b/x', 'org_a')).toBe(false);
    expect(isWorkspaceObjectKey('avatars/x.png', 'org_a')).toBe(false);
    expect(isWorkspaceObjectKey('workspaces/org_a', 'org_a')).toBe(false);
  });

  it('round-trips a key through its private URL', () => {
    const url = privateObjectUrl('https://app-api.example/', KEY);
    expect(url).toBe('https://app-api.example/api/storage/private/workspaces/org_a/drive/general/1_abc/report%20final.pdf');
    expect(keyFromPrivateObjectUrl(url)).toBe(KEY);
    expect(keyFromPrivateObjectUrl('https://files.example/workspaces/org_a/x')).toBeNull();
    expect(keyFromPrivateObjectUrl('not a url')).toBeNull();
  });
});

describe('bucket resolution', () => {
  it('prefers the private bucket and falls back to the public one', async () => {
    const env = {
      PRIVATE_STORAGE: memoryBucket({ [KEY]: 'private' }),
      STORAGE: memoryBucket({ [KEY]: 'stale', 'workspaces/org_a/old.png': 'legacy' }),
    };
    expect((await getStoredObject(env, KEY))?.body).toBe('private');
    expect((await getStoredObject(env, 'workspaces/org_a/old.png'))?.body).toBe('legacy');
    expect((await locateStoredObject(env, 'workspaces/org_a/old.png'))?.bucket).toBe('public');
    expect(await getStoredObject(env, 'workspaces/org_a/missing')).toBeNull();
  });

  it('works for a worker without the private binding', async () => {
    const env = { STORAGE: memoryBucket({ [KEY]: 'public' }) };
    expect((await getStoredObject(env, KEY))?.body).toBe('public');
  });

  it('overwrites an object in the bucket that holds it', async () => {
    const env = { PRIVATE_STORAGE: memoryBucket(), STORAGE: memoryBucket({ [KEY]: 'v1' }) };
    expect((await putStoredObject(env, KEY, 'v2')).bucket).toBe('public');
    expect(env.STORAGE.objects.get(KEY)).toBe('v2');
    expect(env.PRIVATE_STORAGE.objects.has(KEY)).toBe(false);

    expect((await putStoredObject(env, 'workspaces/org_a/new', 'n')).bucket).toBe('private');
  });

  it('deletes from both buckets', async () => {
    const env = { PRIVATE_STORAGE: memoryBucket({ [KEY]: 'a' }), STORAGE: memoryBucket({ [KEY]: 'b' }) };
    await deleteStoredObject(env, KEY);
    expect(env.PRIVATE_STORAGE.objects.size + env.STORAGE.objects.size).toBe(0);
  });
});

describe('files cookie', () => {
  it('grants its own workspace only', async () => {
    const { value } = await signFilesCookie(SECRET, 'org_a');
    expect(await verifyFilesCookie(SECRET, value, 'org_a')).toBe(true);
    expect(await verifyFilesCookie(SECRET, value, 'org_b')).toBe(false);
    expect(await verifyFilesCookie('other-secret', value, 'org_a')).toBe(false);
  });

  it('cannot be re-pointed at another workspace', async () => {
    const { value } = await signFilesCookie(SECRET, 'org_a');
    expect(await verifyFilesCookie(SECRET, value.replace('org_a', 'org_b'), 'org_b')).toBe(false);
  });

  it('expires', async () => {
    vi.useFakeTimers();
    const { value } = await signFilesCookie(SECRET, 'org_a', 60);
    vi.advanceTimersByTime(61_000);
    expect(await verifyFilesCookie(SECRET, value, 'org_a')).toBe(false);
  });

  it('is scoped to the workspace prefix', () => {
    expect(filesCookiePath('org_a')).toBe('/api/storage/private/workspaces/org_a/');
  });

  it('collects every value of a repeated cookie', () => {
    expect(cookieValues('a=1; ws_files=x; ws_files=y', 'ws_files')).toEqual(['x', 'y']);
    expect(cookieValues(undefined, 'ws_files')).toEqual([]);
  });
});

describe('signed URLs', () => {
  it('verify for their key only', async () => {
    const { url } = await signPrivateObjectUrl(SECRET, 'https://app-api.example', KEY);
    const q = new URL(url).searchParams;
    expect(await verifyPrivateObjectSignature(SECRET, KEY, q.get('exp')!, q.get('sig')!)).toBe(true);
    expect(await verifyPrivateObjectSignature(SECRET, 'workspaces/org_a/other', q.get('exp')!, q.get('sig')!)).toBe(false);
    expect(await verifyPrivateObjectSignature(SECRET, KEY, String(Number(q.get('exp')) + 1), q.get('sig')!)).toBe(false);
  });

  it('are not interchangeable with a files cookie', async () => {
    const { value, expiresAt } = await signFilesCookie(SECRET, 'org_a');
    const sig = value.split('.')[3];
    expect(await verifyPrivateObjectSignature(SECRET, KEY, String(expiresAt), sig)).toBe(false);
  });

  it('expire', async () => {
    vi.useFakeTimers();
    const { url } = await signPrivateObjectUrl(SECRET, 'https://app-api.example', KEY, 30);
    const q = new URL(url).searchParams;
    vi.advanceTimersByTime(31_000);
    expect(await verifyPrivateObjectSignature(SECRET, KEY, q.get('exp')!, q.get('sig')!)).toBe(false);
  });
});

describe('inline content types', () => {
  it('renders images, media, PDF and plain text inline', () => {
    for (const t of ['image/png', 'image/jpeg', 'video/mp4', 'audio/webm', 'application/pdf', 'text/plain; charset=utf-8']) {
      expect(isInlineSafeContentType(t)).toBe(true);
    }
  });

  it('downloads anything that could run script', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/xml', 'application/javascript', '', null]) {
      expect(isInlineSafeContentType(t)).toBe(false);
    }
  });
});
