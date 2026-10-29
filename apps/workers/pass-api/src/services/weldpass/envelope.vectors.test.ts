/**
 * Cross-backend envelope vectors: what the Rust backend (rust/modules/pass,
 * envelope.rs) sealed must open here, bit for bit, and the reverse is checked
 * in Rust against fixtures this code wrote (rust/modules/pass/tools/fixtures.mts).
 *
 * The Rust side sealed with fixed randomness, so its file is reproducible;
 * the TypeScript side can only take what Web Crypto's random IVs and keys
 * give, so those ciphertexts are recorded instead. Both directions also check
 * that the additional data binds: the same ciphertext refuses to open at
 * another location.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  checksumFor,
  hintFor,
  openItem,
  openSecret,
  unwrapVaultKey,
  versionOf,
  type RootKeyring,
  type SecretLocation,
} from './envelope';

interface RustVectors {
  projects: Array<{ ownerId: string; keyring: RootKeyring; kekWrapped: string; rootKeyVersion: string; kekHex: string }>;
  secrets: Array<{
    location: SecretLocation;
    plaintext: string;
    ciphertext: string;
    dekWrapped: string;
    checksum: string;
    valueLength: number;
    valueHint: string | null;
  }>;
  items: Array<{
    location: { vaultId: string; itemId: string };
    plaintext: string;
    ciphertext: string;
    dekWrapped: string;
  }>;
}

const fixtures = path.resolve(__dirname, '../../../../../../rust/modules/pass/tests/fixtures');
const rust = JSON.parse(readFileSync(path.join(fixtures, 'envelope-rust.json'), 'utf8')) as RustVectors;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('envelope · ciphertexts the Rust backend sealed', () => {
  it('unwraps its vault keys, under v1 and after a rotation to v2', async () => {
    for (const project of rust.projects) {
      const kek = await unwrapVaultKey(project.keyring, project.ownerId, project.kekWrapped);
      expect(hex(kek)).toBe(project.kekHex);
      expect(versionOf(project.kekWrapped)).toBe(project.rootKeyVersion);
      await expect(unwrapVaultKey(project.keyring, `${project.ownerId}_x`, project.kekWrapped)).rejects.toThrow(
        EnvelopeError,
      );
    }
  });

  it('opens its secrets and agrees on checksum, length and hint', async () => {
    const kek = await unwrapVaultKey(rust.projects[0].keyring, rust.projects[0].ownerId, rust.projects[0].kekWrapped);
    for (const secret of rust.secrets) {
      expect(await openSecret(kek, secret.location, secret)).toBe(secret.plaintext);
      expect(await checksumFor(kek, secret.location, secret.plaintext)).toBe(secret.checksum);
      expect(secret.plaintext).toHaveLength(secret.valueLength);
      expect(hintFor(secret.plaintext)).toBe(secret.valueHint);
      await expect(
        openSecret(kek, { ...secret.location, environmentId: `${secret.location.environmentId}_x` }, secret),
      ).rejects.toThrow(EnvelopeError);
    }
  });

  it('opens its password items and refuses them in another vault', async () => {
    const vault = rust.projects.find((project) => project.ownerId.startsWith('wpk'));
    if (!vault) throw new Error('no vault key in the fixture');
    const kek = await unwrapVaultKey(vault.keyring, vault.ownerId, vault.kekWrapped);
    for (const item of rust.items) {
      expect(await openItem(kek, item.location, item)).toBe(item.plaintext);
      await expect(openItem(kek, { ...item.location, vaultId: 'wpk_other' }, item)).rejects.toThrow(EnvelopeError);
    }
  });
});
