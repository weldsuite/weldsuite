import { describe, it, expect } from 'vitest';
import {
  openCachedDatabaseUrl,
  sealCachedDatabaseUrl,
  sealedMcpOrgCacheKey,
  sealedWorkspaceCacheKey,
  sealedWorkspaceIdCacheKey,
} from './workspace-url-cache';

// 32-byte hex keys (64 chars), fixed for deterministic tests
const KEY_V1 = 'a'.repeat(64);
const KEY_V2 = 'b'.repeat(64);
const OTHER_KEY = 'c'.repeat(64);
const URL = 'postgresql://user:s3cret@ep-1.neon.tech/db?sslmode=require';

describe('sealed cache keys', () => {
  it('never reuse the old plaintext key prefixes', () => {
    expect(sealedWorkspaceCacheKey('org_1')).toBe('wsx:org_1');
    expect(sealedWorkspaceIdCacheKey('ws_1')).toBe('wsx:id:ws_1');
    expect(sealedMcpOrgCacheKey('org_1')).toBe('mcpx:org:org_1');
    for (const key of [sealedWorkspaceCacheKey('x'), sealedWorkspaceIdCacheKey('x'), sealedMcpOrgCacheKey('x')]) {
      expect(key.startsWith('ws:')).toBe(false);
      expect(key.startsWith('mcp:org:')).toBe(false);
    }
  });
});

describe('sealCachedDatabaseUrl / openCachedDatabaseUrl', () => {
  it('round-trips a URL and does not leak it in the sealed value', async () => {
    const sealed = await sealCachedDatabaseUrl(URL, { v1: KEY_V1 });
    expect(sealed).toEqual(expect.any(String));
    expect(sealed).not.toContain('postgres');
    expect(sealed).not.toContain('s3cret');
    expect(await openCachedDatabaseUrl(sealed, { v1: KEY_V1 })).toBe(URL);
  });

  it('accepts a bare string key and a v1+v2 keyring', async () => {
    const sealed = await sealCachedDatabaseUrl(URL, KEY_V1);
    expect(await openCachedDatabaseUrl(sealed, KEY_V1)).toBe(URL);

    const ring = { v1: KEY_V1, v2: KEY_V2 };
    const sealedV2 = await sealCachedDatabaseUrl(URL, ring);
    expect(sealedV2).toMatch(/^v2:/);
    expect(await openCachedDatabaseUrl(sealedV2, ring)).toBe(URL);
  });

  it('seals a different ciphertext every time', async () => {
    const a = await sealCachedDatabaseUrl(URL, KEY_V1);
    const b = await sealCachedDatabaseUrl(URL, KEY_V1);
    expect(a).not.toBe(b);
  });

  it('returns null (do not cache) when there is no key', async () => {
    expect(await sealCachedDatabaseUrl(URL, undefined)).toBeNull();
    expect(await sealCachedDatabaseUrl(URL, null)).toBeNull();
    expect(await sealCachedDatabaseUrl(URL, '')).toBeNull();
    expect(await sealCachedDatabaseUrl(URL, {})).toBeNull();
    expect(await sealCachedDatabaseUrl(URL, { v1: undefined, v2: undefined })).toBeNull();
  });

  it('opens to null with the wrong key', async () => {
    const sealed = await sealCachedDatabaseUrl(URL, { v1: KEY_V1 });
    expect(await openCachedDatabaseUrl(sealed, { v1: OTHER_KEY })).toBeNull();
  });

  it('opens to null with no key', async () => {
    const sealed = await sealCachedDatabaseUrl(URL, { v1: KEY_V1 });
    expect(await openCachedDatabaseUrl(sealed, undefined)).toBeNull();
    expect(await openCachedDatabaseUrl(sealed, {})).toBeNull();
  });

  it('rejects a plaintext URL and other non-sealed values as a miss', async () => {
    expect(await openCachedDatabaseUrl(URL, { v1: KEY_V1 })).toBeNull();
    expect(await openCachedDatabaseUrl('postgres://x/y', { v1: KEY_V1 })).toBeNull();
    expect(await openCachedDatabaseUrl(undefined, { v1: KEY_V1 })).toBeNull();
    expect(await openCachedDatabaseUrl(null, { v1: KEY_V1 })).toBeNull();
    expect(await openCachedDatabaseUrl(42, { v1: KEY_V1 })).toBeNull();
    expect(await openCachedDatabaseUrl('', { v1: KEY_V1 })).toBeNull();
  });

  it('opens to null for a tampered value', async () => {
    const sealed = (await sealCachedDatabaseUrl(URL, { v1: KEY_V1 }))!;
    const flipped = sealed.slice(0, -1) + (sealed.endsWith('0') ? '1' : '0');
    expect(await openCachedDatabaseUrl(flipped, { v1: KEY_V1 })).toBeNull();
  });

  it('opens a value sealed under the v1 key after a v2 key is added to the ring', async () => {
    const sealed = await sealCachedDatabaseUrl(URL, { v1: KEY_V1 });
    expect(await openCachedDatabaseUrl(sealed, { v1: KEY_V1, v2: KEY_V2 })).toBe(URL);
  });
});
