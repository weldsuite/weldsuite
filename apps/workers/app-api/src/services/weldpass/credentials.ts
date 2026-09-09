/**
 * WeldPass provider API tokens (Cloudflare, Vercel).
 *
 * These are secrets too, so they get the same envelope treatment as vault
 * values — sealed under the project KEK, bound to their credential row. They
 * are write-only from the API's point of view: nothing here returns a token,
 * and the only reader is the sync service.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  WeldPassCredentialMetadata,
  WeldPassProvider,
  WeldPassSyncTargetConfig,
} from '@weldsuite/db/schema/weldpass';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { credentialLocation, openSecret, sealSecret } from './envelope';
import { getProvider } from './providers';
import { VaultNotFoundError } from './vault';

const t = schema.weldpassProviderCredentials;

export interface CredentialSummary {
  id: string;
  projectId: string;
  provider: WeldPassProvider;
  name: string;
  metadata: WeldPassCredentialMetadata;
  lastVerifiedAt: Date | null;
  lastVerifyError: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const summaryColumns = {
  id: t.id,
  projectId: t.projectId,
  provider: t.provider,
  name: t.name,
  metadata: t.metadata,
  lastVerifiedAt: t.lastVerifiedAt,
  lastVerifyError: t.lastVerifyError,
  createdBy: t.createdBy,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
};

export async function listCredentials(
  db: Database,
  projectId: string,
): Promise<CredentialSummary[]> {
  return db
    .select(summaryColumns)
    .from(t)
    .where(and(eq(t.projectId, projectId), isNull(t.deletedAt)))
    .orderBy(asc(t.name));
}

export async function requireCredential(
  db: Database,
  projectId: string,
  credentialId: string,
): Promise<CredentialSummary> {
  const [row] = await db
    .select(summaryColumns)
    .from(t)
    .where(and(eq(t.id, credentialId), eq(t.projectId, projectId), isNull(t.deletedAt)))
    .limit(1);
  if (!row) throw new VaultNotFoundError('credential', credentialId);
  return row;
}

export async function createCredential(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: {
    projectId: string;
    provider: WeldPassProvider;
    name: string;
    token: string;
    metadata?: WeldPassCredentialMetadata;
    actorId: string;
  },
): Promise<CredentialSummary> {
  const id = generateId('wpc');
  const sealed = await sealSecret(kek, credentialLocation(input.projectId, id), input.token);

  const [row] = await db
    .insert(t)
    .values({
      id,
      projectId: input.projectId,
      provider: input.provider,
      name: input.name,
      ciphertext: sealed.ciphertext,
      dekWrapped: sealed.dekWrapped,
      metadata: input.metadata ?? {},
      createdBy: input.actorId,
    })
    .returning(summaryColumns);

  return row;
}

export async function updateCredential(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: {
    projectId: string;
    credentialId: string;
    name?: string;
    /** Omit to keep the stored token. */
    token?: string;
    metadata?: WeldPassCredentialMetadata;
  },
): Promise<CredentialSummary> {
  await requireCredential(db, input.projectId, input.credentialId);

  const patch: Partial<typeof t.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.metadata !== undefined) patch.metadata = input.metadata;

  if (input.token !== undefined) {
    const sealed = await sealSecret(
      kek,
      credentialLocation(input.projectId, input.credentialId),
      input.token,
    );
    patch.ciphertext = sealed.ciphertext;
    patch.dekWrapped = sealed.dekWrapped;
    // A new token has not been proven to work yet.
    patch.lastVerifiedAt = null;
    patch.lastVerifyError = null;
  }

  const [row] = await db
    .update(t)
    .set(patch)
    .where(eq(t.id, input.credentialId))
    .returning(summaryColumns);
  return row;
}

export async function deleteCredential(
  db: Database,
  projectId: string,
  credentialId: string,
): Promise<{ detachedTargets: number }> {
  await requireCredential(db, projectId, credentialId);
  const now = new Date();

  // Targets pointing at a deleted credential can no longer sync, so they are
  // retired with it rather than left to fail on the next push.
  const detached = await db
    .update(schema.weldpassSyncTargets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.weldpassSyncTargets.credentialId, credentialId),
        isNull(schema.weldpassSyncTargets.deletedAt),
      ),
    )
    .returning({ id: schema.weldpassSyncTargets.id });

  await db.update(t).set({ deletedAt: now, updatedAt: now }).where(eq(t.id, credentialId));

  return { detachedTargets: detached.length };
}

/** Decrypt a stored token. Only the sync path and `verifyCredential` call this. */
export async function readCredentialToken(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  projectId: string,
  credentialId: string,
): Promise<string> {
  const [row] = await db
    .select({ ciphertext: t.ciphertext, dekWrapped: t.dekWrapped })
    .from(t)
    .where(and(eq(t.id, credentialId), eq(t.projectId, projectId), isNull(t.deletedAt)))
    .limit(1);

  if (!row) throw new VaultNotFoundError('credential', credentialId);
  return openSecret(kek, credentialLocation(projectId, credentialId), row);
}

/**
 * Ask the provider whether a token still works, and record the answer so the UI
 * can show a stale credential before someone discovers it mid-deploy.
 */
export async function verifyCredential(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  projectId: string,
  credentialId: string,
  config: WeldPassSyncTargetConfig,
): Promise<{ ok: boolean; identity?: string; message?: string }> {
  const credential = await requireCredential(db, projectId, credentialId);
  const token = await readCredentialToken(db, kek, projectId, credentialId);

  const result = await getProvider(credential.provider).verify(token, config);

  await db
    .update(t)
    .set({
      lastVerifiedAt: result.ok ? new Date() : credential.lastVerifiedAt,
      lastVerifyError: result.ok ? null : (result.message ?? 'Verification failed'),
      updatedAt: new Date(),
    })
    .where(eq(t.id, credentialId));

  return result;
}
