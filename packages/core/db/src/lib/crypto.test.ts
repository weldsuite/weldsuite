import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  encryptField,
  decryptField,
  maybeDecryptField,
  looksEncrypted,
  keyringFromEnv,
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
    ).toEqual({ v1: KEY_V1, v2: KEY_V2 });
    expect(keyringFromEnv({})).toEqual({ v1: undefined, v2: undefined });
  });
});
