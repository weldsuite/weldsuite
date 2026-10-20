import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt, encryptField, encryptWorkspaceDatabaseUrl } from './crypto';
import { resolveDatabaseUrl } from './neon-resolve';

// 32-byte hex keys (64 chars), fixed for deterministic tests
const KEY_V1 = 'a'.repeat(64);
const KEY_V2 = 'b'.repeat(64);
const RING = { v1: KEY_V1, v2: KEY_V2 };
const AAD_RING = { ...RING, aadWrites: true };
const URL_A = 'postgresql://user:s3cret@ep-a.neon.tech/db?sslmode=require';
const URL_B = 'postgresql://user:s3cret@ep-b.neon.tech/db?sslmode=require';

const neon = {
  neonProjectId: 'proj',
  neonBranchId: 'br',
  neonRoleName: 'role',
  neonDatabaseName: 'neondb',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveDatabaseUrl', () => {
  it('returns a plaintext postgres URL untouched', async () => {
    const url = await resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: URL_A }, RING);
    expect(url).toBe(URL_A);
  });

  it('opens a v3 value for the workspace it belongs to', async () => {
    const stored = await encryptWorkspaceDatabaseUrl(URL_A, 'ws_a', AAD_RING);
    expect(stored).toMatch(/^v3:/);
    const url = await resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: stored }, RING);
    expect(url).toBe(URL_A);
  });

  it('does not route a workspace to the database of another one', async () => {
    // workspace B's row carries the ciphertext that was sealed for workspace A
    const storedForA = await encryptWorkspaceDatabaseUrl(URL_A, 'ws_a', AAD_RING);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      resolveDatabaseUrl('key', { id: 'ws_b', ...neon, databaseUrl: storedForA }, RING),
    ).rejects.toThrow(/authentication failed/);
    // and it must not quietly fall back to the Neon API either
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still opens legacy v1 and v2 values and a bare v1 key string', async () => {
    const v1 = await encrypt(URL_A, KEY_V1);
    const v2 = await encryptField(URL_B, RING);
    expect(await resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: v1 }, RING)).toBe(URL_A);
    expect(await resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: v2 }, RING)).toBe(URL_B);
    expect(await resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: v1 }, KEY_V1)).toBe(URL_A);
  });

  it('throws on a v3 value without the v2 key instead of resolving another way', async () => {
    const stored = await encryptWorkspaceDatabaseUrl(URL_A, 'ws_a', AAD_RING);
    await expect(
      resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: stored }, { v1: KEY_V1 }),
    ).rejects.toThrow(/no v2 key/);
  });

  it('falls back to the Neon API when there is no stored URL or no key', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ uri: URL_B }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: null }, RING)).toBe(URL_B);

    const stored = await encryptWorkspaceDatabaseUrl(URL_A, 'ws_a', AAD_RING);
    expect(await resolveDatabaseUrl('key', { id: 'ws_a', ...neon, databaseUrl: stored }, undefined)).toBe(URL_B);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
