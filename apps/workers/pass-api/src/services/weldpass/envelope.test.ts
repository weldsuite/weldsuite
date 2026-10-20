import { describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  checksumFor,
  checksumMatches,
  createVaultKey,
  credentialLocation,
  currentRootKeyVersion,
  hintFor,
  isLegacyChecksum,
  openSecret,
  rewrapVaultKey,
  sealSecret,
  sha256Hex,
  unwrapVaultKey,
  versionOf,
  type RootKeyring,
  type SecretLocation,
} from './envelope';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const location: SecretLocation = {
  projectId: 'prj_1',
  environmentId: 'env_1',
  key: 'DATABASE_URL',
};

async function vaultKey(keyring: RootKeyring, projectId = location.projectId) {
  const wrapped = await createVaultKey(keyring, projectId);
  return { wrapped, kek: await unwrapVaultKey(keyring, projectId, wrapped.kekWrapped) };
}

describe('root keyring', () => {
  it('prefers v2 when both keys are present', () => {
    expect(currentRootKeyVersion({ v1: KEY_A, v2: KEY_B })).toBe('v2');
    expect(currentRootKeyVersion({ v1: KEY_A })).toBe('v1');
  });

  it('refuses to encrypt with no key configured', () => {
    expect(() => currentRootKeyVersion({})).toThrow(EnvelopeError);
  });

  it('rejects a root key that is not 32 bytes', async () => {
    await expect(createVaultKey({ v1: 'abc' }, 'prj_1')).rejects.toThrow(EnvelopeError);
  });
});

describe('vault keys', () => {
  it('round-trips a KEK through the root key', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    expect(kek.byteLength).toBe(32);
  });

  it('tags the wrapped KEK with the root key version that made it', async () => {
    const wrapped = await createVaultKey({ v1: KEY_A, v2: KEY_B }, 'prj_1');
    expect(wrapped.rootKeyVersion).toBe('v2');
    expect(versionOf(wrapped.kekWrapped)).toBe('v2');
  });

  it('will not unwrap a KEK moved onto a different project', async () => {
    const { wrapped } = await vaultKey({ v1: KEY_A }, 'prj_1');
    await expect(unwrapVaultKey({ v1: KEY_A }, 'prj_2', wrapped.kekWrapped)).rejects.toThrow(
      EnvelopeError,
    );
  });

  it('will not unwrap a KEK under the wrong root key', async () => {
    const { wrapped } = await vaultKey({ v1: KEY_A });
    await expect(
      unwrapVaultKey({ v1: KEY_B }, location.projectId, wrapped.kekWrapped),
    ).rejects.toThrow(EnvelopeError);
  });

  it('rewraps to the new root key without changing the key material', async () => {
    const oldRing: RootKeyring = { v1: KEY_A };
    const { wrapped, kek } = await vaultKey(oldRing);

    const rotated = await rewrapVaultKey({ v1: KEY_A, v2: KEY_B }, location.projectId, wrapped.kekWrapped);
    expect(rotated.rootKeyVersion).toBe('v2');

    const after = await unwrapVaultKey({ v2: KEY_B }, location.projectId, rotated.kekWrapped);
    expect(Array.from(after)).toEqual(Array.from(kek));
  });
});

describe('secret values', () => {
  it('round-trips a value', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const sealed = await sealSecret(kek, location, 'example-db-password');
    expect(await openSecret(kek, location, sealed)).toBe('example-db-password');
  });

  it('never stores the plaintext', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const sealed = await sealSecret(kek, location, 'super-secret-value');
    expect(sealed.ciphertext).not.toContain('super-secret-value');
    expect(sealed.dekWrapped).not.toContain('super-secret-value');
  });

  it('uses a fresh data key per write, so identical values differ on disk', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const first = await sealSecret(kek, location, 'same');
    const second = await sealSecret(kek, location, 'same');
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.dekWrapped).not.toBe(second.dekWrapped);
    // …but the checksum is stable, which is what drift detection relies on.
    expect(first.checksum).toBe(second.checksum);
  });

  it('refuses a value copied into another environment', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const sealed = await sealSecret(kek, location, 'value');
    await expect(
      openSecret(kek, { ...location, environmentId: 'env_2' }, sealed),
    ).rejects.toThrow(EnvelopeError);
  });

  it('refuses a value copied onto another key name', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const sealed = await sealSecret(kek, location, 'value');
    await expect(openSecret(kek, { ...location, key: 'OTHER' }, sealed)).rejects.toThrow(
      EnvelopeError,
    );
  });

  it('refuses a tampered ciphertext', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const sealed = await sealSecret(kek, location, 'value');
    const flipped = sealed.ciphertext.slice(0, -1) + (sealed.ciphertext.endsWith('0') ? '1' : '0');
    await expect(openSecret(kek, location, { ...sealed, ciphertext: flipped })).rejects.toThrow(
      EnvelopeError,
    );
  });

  it('keeps credential tokens bound to their credential row', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const here = credentialLocation('prj_1', 'cred_1');
    const sealed = await sealSecret(kek, here, 'cf-api-token');
    expect(await openSecret(kek, here, sealed)).toBe('cf-api-token');
    await expect(
      openSecret(kek, credentialLocation('prj_1', 'cred_2'), sealed),
    ).rejects.toThrow(EnvelopeError);
  });
});

describe('secret checksums', () => {
  it('is not the SHA-256 of the plaintext', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const sealed = await sealSecret(kek, location, 'hunter2');
    expect(sealed.checksum).not.toBe(await sha256Hex('hunter2'));
    expect(sealed.checksum).not.toContain(await sha256Hex('hunter2'));
  });

  it('is tagged, fits the varchar(64) column and is not legacy', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const { checksum } = await sealSecret(kek, location, 'value');
    expect(checksum).toMatch(/^h1:[0-9a-f]{61}$/);
    expect(checksum).toHaveLength(64);
    expect(isLegacyChecksum(checksum)).toBe(false);
  });

  it('is equal for the same plaintext in the same project', async () => {
    const first = await vaultKey({ v1: KEY_A });
    // A second unwrap of the same wrapped KEK, as a later request would do.
    const kek = await unwrapVaultKey({ v1: KEY_A }, location.projectId, first.wrapped.kekWrapped);
    expect(await checksumFor(first.kek, location, 'same')).toBe(
      await checksumFor(kek, location, 'same'),
    );
  });

  it('differs for different plaintext', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    expect(await checksumFor(kek, location, 'one')).not.toBe(await checksumFor(kek, location, 'two'));
  });

  it('differs between projects, so a hash cannot be reused across vaults', async () => {
    const one = await vaultKey({ v1: KEY_A }, 'prj_1');
    const two = await vaultKey({ v1: KEY_A }, 'prj_2');
    expect(await checksumFor(one.kek, { ...location, projectId: 'prj_1' }, 'same')).not.toBe(
      await checksumFor(two.kek, { ...location, projectId: 'prj_2' }, 'same'),
    );
  });

  it('differs between environments and keys of one project', async () => {
    const { kek } = await vaultKey({ v1: KEY_A });
    const base = await checksumFor(kek, location, 'same');
    expect(await checksumFor(kek, { ...location, environmentId: 'env_2' }, 'same')).not.toBe(base);
    expect(await checksumFor(kek, { ...location, key: 'OTHER' }, 'same')).not.toBe(base);
  });

  it('cannot be reproduced without the KEK, even for the same project id', async () => {
    const real = await vaultKey({ v1: KEY_A });
    const other = await vaultKey({ v1: KEY_B });
    expect(await checksumFor(real.kek, location, 'same')).not.toBe(
      await checksumFor(other.kek, location, 'same'),
    );
  });

  describe('legacy SHA-256 checksums', () => {
    it('are recognised by their missing tag', async () => {
      expect(isLegacyChecksum(await sha256Hex('value'))).toBe(true);
    });

    it('match the same plaintext and no other', async () => {
      const { kek } = await vaultKey({ v1: KEY_A });
      const legacy = await sha256Hex('value');
      const fresh = await checksumFor(kek, location, 'value');
      expect(await checksumMatches(legacy, fresh, 'value')).toBe(true);

      const other = await checksumFor(kek, location, 'changed');
      expect(await checksumMatches(legacy, other, 'changed')).toBe(false);
    });

    it('compare keyed values by the keyed checksum', async () => {
      const { kek } = await vaultKey({ v1: KEY_A });
      const stored = await checksumFor(kek, location, 'value');
      expect(await checksumMatches(stored, await checksumFor(kek, location, 'value'), 'value')).toBe(true);
      expect(await checksumMatches(stored, await checksumFor(kek, location, 'x'), 'x')).toBe(false);
    });
  });
});

describe('non-secret derivatives', () => {
  it('hashes deterministically', async () => {
    expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'));
    expect(await sha256Hex('abc')).not.toBe(await sha256Hex('abd'));
  });

  it('only hints at values long enough to stay masked', () => {
    expect(hintFor('short')).toBeNull();
    expect(hintFor('sk_live_0123456789')).toBe('6789');
  });
});
