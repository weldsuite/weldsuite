/**
 * The people on an envelope: signers fill in fields, copy recipients only get
 * the signed PDF. Access codes are stored as a keyed hash (`codeHash`) and
 * never returned.
 */

import { and, asc, count, eq, max, ne } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SignRecipient } from '@weldsuite/db/schema';
import {
  SIGN_LIMITS,
  type CreateSignRecipientInput,
  type SignLocale,
  type UpdateSignRecipientInput,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { invalid, notFound } from './errors';
import { codeHash } from './hash';

const { signRecipients, signFields } = schema;

export async function listRecipients(db: Database, envelopeId: string): Promise<SignRecipient[]> {
  return db
    .select()
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, envelopeId))
    .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt));
}

export async function getRecipient(db: Database, envelopeId: string, recipientId: string): Promise<SignRecipient> {
  const [row] = await db
    .select()
    .from(signRecipients)
    .where(and(eq(signRecipients.id, recipientId), eq(signRecipients.envelopeId, envelopeId)))
    .limit(1);
  if (!row) throw notFound('Recipient', recipientId);
  return row;
}

async function assertEmailFree(db: Database, envelopeId: string, email: string, exceptId?: string): Promise<void> {
  const conditions = [eq(signRecipients.envelopeId, envelopeId), eq(signRecipients.email, email)];
  if (exceptId) conditions.push(ne(signRecipients.id, exceptId));
  const [taken] = await db.select({ id: signRecipients.id }).from(signRecipients).where(and(...conditions)).limit(1);
  if (taken) throw invalid(`${email} is already a recipient of this envelope`);
}

/** The access-code hash to store, given the auth mode and what was sent. */
async function accessCodeHashFor(
  secret: string | undefined,
  recipientId: string,
  authMode: SignRecipient['authMode'],
  accessCode: string | null | undefined,
  current: string | null,
): Promise<string | null> {
  if (authMode !== 'access_code') return null;
  if (accessCode) {
    if (!secret) throw invalid('Access codes are not available right now');
    return codeHash(secret, recipientId, accessCode);
  }
  if (current) return current;
  throw invalid('An access code is required for this recipient');
}

export async function addRecipient(
  db: Database,
  envelopeId: string,
  input: CreateSignRecipientInput,
  fallbackLocale: SignLocale,
  /** `SIGN_SESSION_SECRET`: keys the access-code hash. */
  secret?: string,
): Promise<SignRecipient> {
  const [{ existing, last }] = await db
    .select({ existing: count(), last: max(signRecipients.routingOrder) })
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, envelopeId));
  if (Number(existing) >= SIGN_LIMITS.maxRecipients) {
    throw invalid(`An envelope can have at most ${SIGN_LIMITS.maxRecipients} recipients`);
  }
  await assertEmailFree(db, envelopeId, input.email);

  const authMode = input.authMode ?? 'link';
  const id = generateId('sgr');
  const [row] = await db
    .insert(signRecipients)
    .values({
      id,
      envelopeId,
      role: input.role ?? 'signer',
      name: input.name,
      email: input.email,
      personId: input.personId ?? null,
      locale: input.locale ?? fallbackLocale,
      // New people go last; with signing order off the number is not used.
      routingOrder: input.routingOrder ?? (last === null ? 1 : Number(last) + 1),
      authMode,
      accessCodeHash: await accessCodeHashFor(secret, id, authMode, input.accessCode, null),
    })
    .returning();
  return row!;
}

export async function updateRecipient(
  db: Database,
  envelopeId: string,
  recipientId: string,
  input: UpdateSignRecipientInput,
  /** `SIGN_SESSION_SECRET`: keys the access-code hash. */
  secret?: string,
): Promise<SignRecipient> {
  const current = await getRecipient(db, envelopeId, recipientId);
  if (input.email !== undefined && input.email !== current.email) await assertEmailFree(db, envelopeId, input.email, recipientId);

  const authMode = input.authMode ?? current.authMode;
  const role = input.role ?? current.role;
  const [row] = await db
    .update(signRecipients)
    .set({
      role,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.email !== undefined && { email: input.email }),
      ...(input.personId !== undefined && { personId: input.personId ?? null }),
      ...(input.locale !== undefined && { locale: input.locale }),
      ...(input.routingOrder !== undefined && { routingOrder: input.routingOrder }),
      authMode,
      accessCodeHash: await accessCodeHashFor(secret, recipientId, authMode, input.accessCode, current.accessCodeHash),
      updatedAt: new Date(),
    })
    .where(eq(signRecipients.id, recipientId))
    .returning();
  // A copy recipient fills nothing in: drop any fields they had as a signer.
  if (role === 'cc' && current.role !== 'cc') await db.delete(signFields).where(eq(signFields.recipientId, recipientId));
  return row!;
}

export async function removeRecipient(db: Database, envelopeId: string, recipientId: string): Promise<void> {
  await getRecipient(db, envelopeId, recipientId);
  await db.delete(signFields).where(eq(signFields.recipientId, recipientId));
  await db.delete(signRecipients).where(eq(signRecipients.id, recipientId));
}
