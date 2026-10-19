/**
 * Checksum behaviour of the secret store against a real schema (pglite):
 * keyed checksums on write, "unchanged" detection, and the lazy upgrade of rows
 * that still hold a bare SHA-256 from before checksums were keyed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  checksumFor,
  createVaultKey,
  isLegacyChecksum,
  sealSecret,
  sha256Hex,
  unwrapVaultKey,
  type SecretLocation,
} from './envelope';
import { backfillChecksums, revealSecret, upsertSecret } from './secrets';

const ROOT = { v1: 'a'.repeat(64) };
const PROJECT = 'prj_checks';
const ENV = 'env_checks';

let db: Database;
let kek: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const wrapped = await createVaultKey(ROOT, PROJECT);
  kek = await unwrapVaultKey(ROOT, PROJECT, wrapped.kekWrapped);
}, 60_000);

const loc = (key: string): SecretLocation => ({ projectId: PROJECT, environmentId: ENV, key });

function put(key: string, value: string, note?: string) {
  return upsertSecret(db, kek, {
    projectId: PROJECT,
    environmentId: ENV,
    key,
    value,
    note,
    actorId: 'user_1',
  });
}

/** A row as an older release wrote it: checksum is the bare SHA-256. */
async function insertLegacy(key: string, value: string) {
  const sealed = await sealSecret(kek, loc(key), value);
  const id = generateId('wps');
  await db.insert(schema.weldpassSecrets).values({
    id,
    projectId: PROJECT,
    environmentId: ENV,
    key,
    ciphertext: sealed.ciphertext,
    dekWrapped: sealed.dekWrapped,
    checksum: await sha256Hex(value),
    valueLength: sealed.valueLength,
    valueHint: sealed.valueHint,
    version: 1,
  });
  await db.insert(schema.weldpassSecretVersions).values({
    id: generateId('wpv'),
    secretId: id,
    projectId: PROJECT,
    version: 1,
    action: 'created',
    ciphertext: sealed.ciphertext,
    dekWrapped: sealed.dekWrapped,
    checksum: await sha256Hex(value),
  });
  return id;
}

async function storedChecksum(id: string) {
  const [row] = await db
    .select({ checksum: schema.weldpassSecrets.checksum })
    .from(schema.weldpassSecrets)
    .where(eq(schema.weldpassSecrets.id, id));
  return row.checksum;
}

describe('upsertSecret checksums', () => {
  it('stores a keyed checksum, not the SHA-256 of the value', async () => {
    const { secret } = await put('NEW_KEY', 'a-low-entropy-pw');
    expect(secret.checksum).toBe(await checksumFor(kek, loc('NEW_KEY'), 'a-low-entropy-pw'));
    expect(secret.checksum).not.toBe(await sha256Hex('a-low-entropy-pw'));
  });

  it('reports an identical re-import as unchanged, and a new value as changed', async () => {
    await put('SAME_KEY', 'v1');
    expect((await put('SAME_KEY', 'v1')).changed).toBe(false);
    const next = await put('SAME_KEY', 'v2');
    expect(next.changed).toBe(true);
    expect(next.secret.version).toBe(2);
  });
});

describe('legacy SHA-256 checksums', () => {
  it('re-importing the same value is unchanged (no new version) and upgrades the row', async () => {
    const id = await insertLegacy('LEGACY_SAME', 'legacy-value');
    expect(isLegacyChecksum(await storedChecksum(id))).toBe(true);

    const result = await put('LEGACY_SAME', 'legacy-value');
    expect(result.changed).toBe(false);
    expect(result.secret.version).toBe(1);
    expect(await storedChecksum(id)).toBe(await checksumFor(kek, loc('LEGACY_SAME'), 'legacy-value'));
  });

  it('a different value on a legacy row is a real change', async () => {
    const id = await insertLegacy('LEGACY_DIFF', 'old-value');
    const result = await put('LEGACY_DIFF', 'new-value');
    expect(result.changed).toBe(true);
    expect(result.secret.version).toBe(2);
    expect(await storedChecksum(id)).toBe(await checksumFor(kek, loc('LEGACY_DIFF'), 'new-value'));
  });

  it('revealing upgrades the checksum and still returns the value', async () => {
    const id = await insertLegacy('LEGACY_REVEAL', 'reveal-me');
    const { secret, value } = await revealSecret(db, kek, ENV, id);
    expect(value).toBe('reveal-me');
    expect(isLegacyChecksum(secret.checksum)).toBe(false);
    expect(await storedChecksum(id)).toBe(secret.checksum);
    // A second import now compares keyed to keyed.
    expect((await put('LEGACY_REVEAL', 'reveal-me')).changed).toBe(false);
  });

  it('backfill re-keys current and history rows, once', async () => {
    const id = await insertLegacy('LEGACY_BACKFILL', 'backfill-me');
    const first = await backfillChecksums(db, kek, PROJECT);
    expect(first.secrets).toBeGreaterThanOrEqual(1);
    expect(first.versions).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);
    expect(await storedChecksum(id)).toBe(await checksumFor(kek, loc('LEGACY_BACKFILL'), 'backfill-me'));

    const versionRows = await db
      .select({ checksum: schema.weldpassSecretVersions.checksum })
      .from(schema.weldpassSecretVersions)
      .where(eq(schema.weldpassSecretVersions.secretId, id));
    expect(versionRows.every((row) => !isLegacyChecksum(row.checksum))).toBe(true);

    expect(await backfillChecksums(db, kek, PROJECT)).toEqual({ secrets: 0, versions: 0, failed: 0 });
  });
});
