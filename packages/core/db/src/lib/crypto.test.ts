import { describe, it, expect } from 'vitest';
import {
  aadWritesEnabled,
  decrypt,
  decryptField,
  decryptWorkspaceDatabaseUrl,
  encrypt,
  encryptField,
  encryptWorkspaceDatabaseUrl,
  isAadBound,
  keyringFromEnv,
  looksEncrypted,
  maybeDecryptField,
  workspaceDatabaseUrlAad,
} from './crypto';

// 32-byte hex keys (64 chars), fixed for deterministic tests
const KEY_V1 = 'a'.repeat(64);
const KEY_V2 = 'b'.repeat(64);

describe('legacy v1 encrypt/decrypt', () => {
  it('round-trips a value', async () => {
    const ct = await encrypt('secret-value', KEY_V1);
    expect(ct).toMatch(/^[0-9a-f]+:[0-9a-f]+$/i);
    expect(await decrypt(ct, KEY_V1)).toBe('secret-value');
  });

  it('fails with the wrong key', async () => {
    const ct = await encrypt('secret-value', KEY_V1);
    await expect(decrypt(ct, KEY_V2)).rejects.toThrow();
  });

  it('rejects malformed input', async () => {
    await expect(decrypt('not-encrypted', KEY_V1)).rejects.toThrow();
  });
});

describe('encryptField / decryptField (versioned)', () => {
  it('writes v2 format when a v2 key is present', async () => {
    const ct = await encryptField('secret', { v1: KEY_V1, v2: KEY_V2 });
    expect(ct).toMatch(/^v2:[0-9a-f]+:[0-9a-f]+$/i);
    expect(await decryptField(ct, { v1: KEY_V1, v2: KEY_V2 })).toBe('secret');
  });

  it('falls back to legacy v1 format without a v2 key', async () => {
    const ct = await encryptField('secret', { v1: KEY_V1 });
    expect(ct).toMatch(/^[0-9a-f]+:[0-9a-f]+$/i);
    expect(ct.startsWith('v2:')).toBe(false);
    expect(await decryptField(ct, { v1: KEY_V1 })).toBe('secret');
  });

  it('decrypts legacy v1 values with the v1 key while v2 is active', async () => {
    const legacy = await encrypt('old-secret', KEY_V1);
    expect(await decryptField(legacy, { v1: KEY_V1, v2: KEY_V2 })).toBe('old-secret');
  });

  it('throws when a v2 value arrives but the keyring has no v2 key', async () => {
    const ct = await encryptField('secret', { v2: KEY_V2 });
    await expect(decryptField(ct, { v1: KEY_V1 })).rejects.toThrow(/no v2 key/);
  });

  it('throws when a v1 value arrives but the keyring has no v1 key (post-retirement)', async () => {
    const legacy = await encrypt('old-secret', KEY_V1);
    await expect(decryptField(legacy, { v2: KEY_V2 })).rejects.toThrow(/no v1 key/);
  });

  it('throws on an empty keyring', async () => {
    await expect(encryptField('secret', {})).rejects.toThrow(/no keys/);
  });

  it('rejects unrecognized formats', async () => {
    await expect(decryptField('plaintext', { v1: KEY_V1 })).rejects.toThrow(/not in a recognized/);
  });
});

describe('looksEncrypted', () => {
  it('recognizes both formats and rejects plaintext', async () => {
    expect(looksEncrypted(await encrypt('x', KEY_V1))).toBe(true);
    expect(looksEncrypted(await encryptField('x', { v2: KEY_V2 }))).toBe(true);
    expect(looksEncrypted('postgresql://user:pass@host/db')).toBe(false);
    expect(looksEncrypted('xoxb-plain-token')).toBe(false);
    // bare hex without a colon is not the encrypted shape
    expect(looksEncrypted('deadbeef')).toBe(false);
  });
});

describe('maybeDecryptField', () => {
  it('decrypts encrypted values of either version', async () => {
    const keyring = { v1: KEY_V1, v2: KEY_V2 };
    const v1ct = await encrypt('one', KEY_V1);
    const v2ct = await encryptField('two', keyring);
    expect(await maybeDecryptField(v1ct, keyring)).toBe('one');
    expect(await maybeDecryptField(v2ct, keyring)).toBe('two');
  });

  it('passes plaintext through untouched', async () => {
    expect(await maybeDecryptField('plain-token', { v1: KEY_V1 })).toBe('plain-token');
  });

  it('returns hex-looking non-ciphertext as-is instead of throwing', async () => {
    // matches the v1 format shape but is not actual ciphertext
    expect(await maybeDecryptField('abc123:def456', { v1: KEY_V1 })).toBe('abc123:def456');
  });

  it('returns the raw value when the matching key is missing', async () => {
    const v2ct = await encryptField('secret', { v2: KEY_V2 });
    expect(await maybeDecryptField(v2ct, { v1: KEY_V1 })).toBe(v2ct);
  });
});

describe('keyringFromEnv', () => {
  it('maps env vars to keyring slots', () => {
    expect(
      keyringFromEnv({ DATABASE_ENCRYPTION_KEY: KEY_V1, DATABASE_ENCRYPTION_KEY_V2: KEY_V2 }),
    ).toEqual({ v1: KEY_V1, v2: KEY_V2, aadWrites: false });
    expect(keyringFromEnv({})).toEqual({ v1: undefined, v2: undefined, aadWrites: false });
  });

  it('reads the AAD-writes switch from FIELD_ENCRYPTION_AAD_WRITES', () => {
    const on = keyringFromEnv({ DATABASE_ENCRYPTION_KEY_V2: KEY_V2, FIELD_ENCRYPTION_AAD_WRITES: '1' });
    expect(on.aadWrites).toBe(true);
    expect(keyringFromEnv({ FIELD_ENCRYPTION_AAD_WRITES: 'true' }).aadWrites).toBe(true);
    expect(keyringFromEnv({ DATABASE_ENCRYPTION_KEY_V2: KEY_V2 }).aadWrites).toBe(false);
  });
});

describe('aadWritesEnabled', () => {
  it('is on only for an explicit 1 / true, default off', () => {
    for (const on of ['1', 'true', 'TRUE', ' 1 ', ' True ']) expect(aadWritesEnabled(on)).toBe(true);
    for (const off of [undefined, null, '', '0', 'false', 'yes', 'on', '2']) {
      expect(aadWritesEnabled(off)).toBe(false);
    }
  });
});

// ── workspaces.database_url: v3, AAD-bound (audit finding 657) ───────────────

const DB_URL = 'postgresql://user:s3cret@ep-1.neon.tech/db?sslmode=require';
const RING = { v1: KEY_V1, v2: KEY_V2 };
const AAD_RING = { v1: KEY_V1, v2: KEY_V2, aadWrites: true };

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Flip one hex digit of the ciphertext segment (the bytes after the IV). */
function tamper(value: string): string {
  const parts = value.split(':');
  const cipher = parts[parts.length - 1] ?? '';
  const flipped = (cipher[0] === '0' ? '1' : '0') + cipher.slice(1);
  return [...parts.slice(0, -1), flipped].join(':');
}

describe('v3 workspace database URL (AAD-bound)', () => {
  it('round-trips for the workspace it was sealed for', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    expect(ct).toMatch(/^v3:[0-9a-f]+:[0-9a-f]+$/i);
    expect(ct).not.toContain('postgres');
    expect(ct).not.toContain('s3cret');
    expect(isAadBound(ct)).toBe(true);
    expect(looksEncrypted(ct)).toBe(true);
    expect(await decryptWorkspaceDatabaseUrl(ct, 'ws_a', RING)).toBe(DB_URL);
  });

  it('seals a different ciphertext every time', async () => {
    const a = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    const b = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    expect(a).not.toBe(b);
  });

  it('uses the documented AAD string with the v2 key', async () => {
    expect(workspaceDatabaseUrlAad('ws_a')).toBe('workspaces:ws_a:database_url');
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    const [, ivHex, cipherHex] = ct.split(':') as [string, string, string];
    const key = await crypto.subtle.importKey('raw', hexBytes(KEY_V2), { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: hexBytes(ivHex),
        additionalData: new TextEncoder().encode('workspaces:ws_a:database_url'),
      },
      key,
      hexBytes(cipherHex),
    );
    expect(new TextDecoder().decode(plain)).toBe(DB_URL);
  });

  it('refuses a value copied onto another workspace row', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    await expect(decryptWorkspaceDatabaseUrl(ct, 'ws_b', RING)).rejects.toThrow(/authentication failed/);
    // the same value is still fine on its own row
    expect(await decryptWorkspaceDatabaseUrl(ct, 'ws_a', RING)).toBe(DB_URL);
  });

  it('does not match on a workspace id that only looks similar', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    for (const other of ['ws_a ', 'WS_A', 'ws_a:database_url', '']) {
      await expect(decryptWorkspaceDatabaseUrl(ct, other, RING)).rejects.toThrow();
    }
  });

  it('needs a workspace id to open, and to seal', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    await expect(decryptWorkspaceDatabaseUrl(ct, '', RING)).rejects.toThrow(/workspaceId is required/);
    await expect(encryptWorkspaceDatabaseUrl(DB_URL, '', AAD_RING)).rejects.toThrow(/workspaceId is required/);
  });

  it('needs the v2 key to open', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    await expect(decryptWorkspaceDatabaseUrl(ct, 'ws_a', { v1: KEY_V1 })).rejects.toThrow(/no v2 key/);
    await expect(
      decryptWorkspaceDatabaseUrl(ct, 'ws_a', { v1: KEY_V1, v2: 'c'.repeat(64) }),
    ).rejects.toThrow(/authentication failed/);
  });

  it('rejects tampered ciphertext and a tampered IV', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    await expect(decryptWorkspaceDatabaseUrl(tamper(ct), 'ws_a', RING)).rejects.toThrow(/authentication failed/);

    const [tag, iv, body] = ct.split(':') as [string, string, string];
    const badIv = (iv[0] === '0' ? '1' : '0') + iv.slice(1);
    await expect(
      decryptWorkspaceDatabaseUrl(`${tag}:${badIv}:${body}`, 'ws_a', RING),
    ).rejects.toThrow(/authentication failed/);
  });

  it('cannot be downgraded by rewriting the version tag', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    const body = ct.slice('v3:'.length);
    // as v2: right key, no AAD, so the tag cannot verify
    await expect(decryptWorkspaceDatabaseUrl(`v2:${body}`, 'ws_a', RING)).rejects.toThrow();
    await expect(decryptField(`v2:${body}`, RING)).rejects.toThrow();
    // as legacy v1: wrong key and no AAD
    await expect(decryptWorkspaceDatabaseUrl(body, 'ws_a', RING)).rejects.toThrow();
  });
});

describe('workspace database URL, legacy values and the write switch', () => {
  it('still opens legacy v1 and v2 values, with or without a workspace id', async () => {
    const v1 = await encrypt(DB_URL, KEY_V1);
    const v2 = await encryptField(DB_URL, RING);
    expect(v2).toMatch(/^v2:/);
    for (const id of ['ws_a', 'ws_b', '']) {
      expect(await decryptWorkspaceDatabaseUrl(v1, id, RING)).toBe(DB_URL);
      expect(await decryptWorkspaceDatabaseUrl(v2, id, RING)).toBe(DB_URL);
    }
  });

  it('writes v2 while the switch is off', async () => {
    const off = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', RING);
    expect(off).toMatch(/^v2:[0-9a-f]+:[0-9a-f]+$/i);
    const explicitOff = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', { ...RING, aadWrites: false });
    expect(explicitOff).toMatch(/^v2:/);
    expect(await decryptWorkspaceDatabaseUrl(off, 'ws_b', RING)).toBe(DB_URL);
  });

  it('writes v3 when the switch is on, driven by the env flag', async () => {
    const fromEnv = keyringFromEnv({
      DATABASE_ENCRYPTION_KEY: KEY_V1,
      DATABASE_ENCRYPTION_KEY_V2: KEY_V2,
      FIELD_ENCRYPTION_AAD_WRITES: '1',
    });
    const on = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', fromEnv);
    expect(on).toMatch(/^v3:/);

    const flagOff = keyringFromEnv({ DATABASE_ENCRYPTION_KEY: KEY_V1, DATABASE_ENCRYPTION_KEY_V2: KEY_V2 });
    expect(await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', flagOff)).toMatch(/^v2:/);
  });

  it('falls back to what encryptField writes when the switch is on but there is no v2 key', async () => {
    const ct = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', { v1: KEY_V1, aadWrites: true });
    expect(ct).toMatch(/^[0-9a-f]+:[0-9a-f]+$/i);
    expect(await decryptWorkspaceDatabaseUrl(ct, 'ws_a', { v1: KEY_V1 })).toBe(DB_URL);
    await expect(encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', { aadWrites: true })).rejects.toThrow(/no keys/);
  });

  it('keeps every other field off v3, even with the switch on', async () => {
    const ct = await encryptField('some-token', AAD_RING);
    expect(ct).toMatch(/^v2:/);
    expect(await decryptField(ct, AAD_RING)).toBe('some-token');
  });

  it('keeps the generic helpers away from v3 values', async () => {
    const v3 = await encryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', AAD_RING);
    await expect(decryptField(v3, RING)).rejects.toThrow(/v3 \(AAD-bound\)/);
    // maybeDecryptField hands an unopenable value back, never a wrong plaintext
    expect(await maybeDecryptField(v3, RING)).toBe(v3);
    expect(isAadBound(await encryptField('x', RING))).toBe(false);
    expect(isAadBound('postgresql://user:pass@host/db')).toBe(false);
  });

  it('refuses a plaintext value', async () => {
    await expect(decryptWorkspaceDatabaseUrl(DB_URL, 'ws_a', RING)).rejects.toThrow(/not in a recognized/);
  });
});
