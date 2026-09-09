/**
 * WeldPass secret reads and writes.
 *
 * Listing never decrypts. Only `revealSecret` and `readEnvironmentValues` open
 * a value, and both are gated on `secrets:reveal` at the route and written to
 * the WeldPass audit trail. Every write appends to `weldpass_secret_versions`
 * before the current row changes, so a bad edit is recoverable.
 */

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { isValidSecretKey } from './dotenv';
import { openSecret, sealSecret, type SecretLocation } from './envelope';
import { VaultNotFoundError } from './vault';

const t = schema.weldpassSecrets;
const versions = schema.weldpassSecretVersions;

/** What a client sees without `secrets:reveal`. */
export interface SecretSummary {
  id: string;
  projectId: string;
  environmentId: string;
  key: string;
  note: string | null;
  version: number;
  valueLength: number;
  valueHint: string | null;
  checksum: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretVersionSummary {
  id: string;
  version: number;
  action: string;
  checksum: string;
  createdBy: string | null;
  createdAt: Date;
}

export class SecretKeyError extends Error {
  constructor(key: string) {
    super(
      `"${key}" is not a usable environment variable name — use letters, digits and underscores, starting with a letter or underscore.`,
    );
    this.name = 'SecretKeyError';
  }
}

const summaryColumns = {
  id: t.id,
  projectId: t.projectId,
  environmentId: t.environmentId,
  key: t.key,
  note: t.note,
  version: t.version,
  valueLength: t.valueLength,
  valueHint: t.valueHint,
  checksum: t.checksum,
  createdBy: t.createdBy,
  updatedBy: t.updatedBy,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
};

function locationOf(secret: {
  projectId: string;
  environmentId: string;
  key: string;
}): SecretLocation {
  return {
    projectId: secret.projectId,
    environmentId: secret.environmentId,
    key: secret.key,
  };
}

export async function listSecrets(
  db: Database,
  environmentId: string,
): Promise<SecretSummary[]> {
  return db
    .select(summaryColumns)
    .from(t)
    .where(and(eq(t.environmentId, environmentId), isNull(t.deletedAt)))
    .orderBy(asc(t.key));
}

export async function requireSecret(
  db: Database,
  environmentId: string,
  secretId: string,
): Promise<SecretSummary> {
  const [row] = await db
    .select(summaryColumns)
    .from(t)
    .where(and(eq(t.id, secretId), eq(t.environmentId, environmentId), isNull(t.deletedAt)))
    .limit(1);
  if (!row) throw new VaultNotFoundError('secret', secretId);
  return row;
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

/** Decrypt one value. The caller must have already checked `secrets:reveal`. */
export async function revealSecret(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  environmentId: string,
  secretId: string,
): Promise<{ secret: SecretSummary; value: string }> {
  const [row] = await db
    .select({ ...summaryColumns, ciphertext: t.ciphertext, dekWrapped: t.dekWrapped })
    .from(t)
    .where(and(eq(t.id, secretId), eq(t.environmentId, environmentId), isNull(t.deletedAt)))
    .limit(1);

  if (!row) throw new VaultNotFoundError('secret', secretId);

  const { ciphertext, dekWrapped, ...secret } = row;
  const value = await openSecret(kek, locationOf(secret), { ciphertext, dekWrapped });
  return { secret, value };
}

/** Every value in an environment, for export or a sync push. */
export async function readEnvironmentValues(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  environmentId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      projectId: t.projectId,
      environmentId: t.environmentId,
      key: t.key,
      ciphertext: t.ciphertext,
      dekWrapped: t.dekWrapped,
    })
    .from(t)
    .where(and(eq(t.environmentId, environmentId), isNull(t.deletedAt)))
    .orderBy(asc(t.key));

  const values: Record<string, string> = {};
  for (const row of rows) {
    values[row.key] = await openSecret(kek, locationOf(row), row);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface UpsertSecretInput {
  projectId: string;
  environmentId: string;
  key: string;
  value: string;
  note?: string | null;
  actorId: string;
}

export interface UpsertResult {
  secret: SecretSummary;
  created: boolean;
  /** False when the submitted value matched what was already stored. */
  changed: boolean;
}

/**
 * Create or replace one secret.
 *
 * An unchanged value is a no-op rather than a new version: people re-import the
 * same `.env` all the time, and a history full of identical entries makes the
 * real change impossible to find. The checksum comparison does this without
 * decrypting the stored value.
 */
export async function upsertSecret(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: UpsertSecretInput,
): Promise<UpsertResult> {
  if (!isValidSecretKey(input.key)) throw new SecretKeyError(input.key);

  const [existing] = await db
    .select({
      id: t.id,
      version: t.version,
      checksum: t.checksum,
      note: t.note,
    })
    .from(t)
    .where(and(eq(t.environmentId, input.environmentId), eq(t.key, input.key)))
    .limit(1);

  const location: SecretLocation = {
    projectId: input.projectId,
    environmentId: input.environmentId,
    key: input.key,
  };
  const sealed = await sealSecret(kek, location, input.value);
  const now = new Date();

  if (!existing) {
    const id = generateId('wps');
    const [row] = await db
      .insert(t)
      .values({
        id,
        projectId: input.projectId,
        environmentId: input.environmentId,
        key: input.key,
        ciphertext: sealed.ciphertext,
        dekWrapped: sealed.dekWrapped,
        checksum: sealed.checksum,
        valueLength: sealed.valueLength,
        valueHint: sealed.valueHint,
        note: input.note ?? null,
        version: 1,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      .returning(summaryColumns);

    await appendVersion(db, {
      secretId: id,
      projectId: input.projectId,
      version: 1,
      action: 'created',
      ciphertext: sealed.ciphertext,
      dekWrapped: sealed.dekWrapped,
      checksum: sealed.checksum,
      createdBy: input.actorId,
    });

    return { secret: row, created: true, changed: true };
  }

  const noteChanged = input.note !== undefined && input.note !== existing.note;
  if (existing.checksum === sealed.checksum && !noteChanged) {
    const secret = await requireSecret(db, input.environmentId, existing.id);
    return { secret, created: false, changed: false };
  }

  const nextVersion = existing.version + 1;

  // History first: if the update lands and this does not, the trail is short a
  // row; the other order could lose the only copy of the previous value.
  await appendVersion(db, {
    secretId: existing.id,
    projectId: input.projectId,
    version: nextVersion,
    action: 'updated',
    ciphertext: sealed.ciphertext,
    dekWrapped: sealed.dekWrapped,
    checksum: sealed.checksum,
    createdBy: input.actorId,
  });

  const [row] = await db
    .update(t)
    .set({
      ciphertext: sealed.ciphertext,
      dekWrapped: sealed.dekWrapped,
      checksum: sealed.checksum,
      valueLength: sealed.valueLength,
      valueHint: sealed.valueHint,
      note: input.note === undefined ? existing.note : input.note,
      version: nextVersion,
      updatedBy: input.actorId,
      updatedAt: now,
      // Re-adding a key that was deleted revives the same row and its history.
      deletedAt: null,
    })
    .where(eq(t.id, existing.id))
    .returning(summaryColumns);

  return { secret: row, created: false, changed: true };
}

/** Bulk upsert, used by `.env` import. Reports what actually changed. */
export async function importSecrets(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: {
    projectId: string;
    environmentId: string;
    values: Record<string, string>;
    actorId: string;
  },
): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const [key, value] of Object.entries(input.values)) {
    const result = await upsertSecret(db, kek, {
      projectId: input.projectId,
      environmentId: input.environmentId,
      key,
      value,
      actorId: input.actorId,
    });
    if (result.created) created.push(key);
    else if (result.changed) updated.push(key);
    else unchanged.push(key);
  }

  return { created, updated, unchanged };
}

export async function deleteSecret(
  db: Database,
  environmentId: string,
  secretId: string,
  actorId: string,
): Promise<SecretSummary> {
  const secret = await requireSecret(db, environmentId, secretId);

  const [current] = await db
    .select({ ciphertext: t.ciphertext, dekWrapped: t.dekWrapped })
    .from(t)
    .where(eq(t.id, secretId))
    .limit(1);

  // A concurrent delete between the two reads leaves nothing to archive.
  if (!current) throw new VaultNotFoundError('secret', secretId);

  const now = new Date();
  await db
    .update(t)
    .set({ deletedAt: now, updatedAt: now, updatedBy: actorId })
    .where(eq(t.id, secretId));

  // The deletion is a version too, so history reads as a complete story.
  await appendVersion(db, {
    secretId,
    projectId: secret.projectId,
    version: secret.version + 1,
    action: 'deleted',
    ciphertext: current.ciphertext,
    dekWrapped: current.dekWrapped,
    checksum: secret.checksum,
    createdBy: actorId,
  });

  return secret;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function listVersions(
  db: Database,
  secretId: string,
  limit = 50,
): Promise<SecretVersionSummary[]> {
  return db
    .select({
      id: versions.id,
      version: versions.version,
      action: versions.action,
      checksum: versions.checksum,
      createdBy: versions.createdBy,
      createdAt: versions.createdAt,
    })
    .from(versions)
    .where(eq(versions.secretId, secretId))
    .orderBy(desc(versions.version))
    .limit(limit);
}

/**
 * Roll a secret back to an earlier version.
 *
 * The old ciphertext is reused as-is rather than decrypted and resealed: the
 * value is bound to the same project/environment/key, so it still opens, and
 * the plaintext never has to exist in memory to undo a mistake.
 */
export async function restoreVersion(
  db: Database,
  environmentId: string,
  secretId: string,
  version: number,
  actorId: string,
): Promise<SecretSummary> {
  const secret = await requireSecret(db, environmentId, secretId);

  const [target] = await db
    .select({
      ciphertext: versions.ciphertext,
      dekWrapped: versions.dekWrapped,
      checksum: versions.checksum,
    })
    .from(versions)
    .where(and(eq(versions.secretId, secretId), eq(versions.version, version)))
    .limit(1);

  if (!target) throw new VaultNotFoundError('secret', `${secretId}@v${version}`);

  const nextVersion = secret.version + 1;
  await appendVersion(db, {
    secretId,
    projectId: secret.projectId,
    version: nextVersion,
    action: 'restored',
    ciphertext: target.ciphertext,
    dekWrapped: target.dekWrapped,
    checksum: target.checksum,
    createdBy: actorId,
  });

  const [row] = await db
    .update(t)
    .set({
      ciphertext: target.ciphertext,
      dekWrapped: target.dekWrapped,
      checksum: target.checksum,
      version: nextVersion,
      updatedBy: actorId,
      updatedAt: new Date(),
      deletedAt: null,
    })
    .where(eq(t.id, secretId))
    .returning(summaryColumns);

  return row;
}

async function appendVersion(
  db: Database,
  entry: {
    secretId: string;
    projectId: string;
    version: number;
    action: 'created' | 'updated' | 'deleted' | 'restored';
    ciphertext: string;
    dekWrapped: string;
    checksum: string;
    createdBy: string;
  },
): Promise<void> {
  await db.insert(versions).values({ id: generateId('wpv'), ...entry });
}

/** Keys present in an environment — used to preview a sync without decrypting. */
export async function listSecretKeys(
  db: Database,
  environmentIds: string[],
): Promise<Map<string, string[]>> {
  if (environmentIds.length === 0) return new Map();

  const rows = await db
    .select({ environmentId: t.environmentId, key: t.key })
    .from(t)
    .where(and(inArray(t.environmentId, environmentIds), isNull(t.deletedAt)))
    .orderBy(asc(t.key));

  const byEnvironment = new Map<string, string[]>();
  for (const row of rows) {
    const keys = byEnvironment.get(row.environmentId) ?? [];
    keys.push(row.key);
    byEnvironment.set(row.environmentId, keys);
  }
  return byEnvironment;
}
