/**
 * Master DB phone_number → clerkOrgId registry for inbound Telnyx routing.
 *
 * A row belongs to one workspace and names that workspace's own
 * voip_phone_numbers row. Whoever lets go of a number (`deactivate…`,
 * `release…`) touches only its own row, so one workspace's clean-up can never
 * cut off a number another workspace has since taken (ported in, say).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { getMasterDb, masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { TelnyxEnv } from './telnyx';

/** A workspace's own registry row: the number, the workspace and the number's row in its tenant. */
export interface OwnRegistryRow {
  phoneNumber: string;
  /** The Clerk org id the registry is keyed by. */
  clerkOrgId: string;
  voipPhoneNumberId: string;
}

function ownRow(row: OwnRegistryRow) {
  const r = masterSchema.phoneNumberRegistry;
  return and(
    eq(r.phoneNumber, normalizeE164(row.phoneNumber)),
    eq(r.clerkOrgId, row.clerkOrgId),
    eq(r.voipPhoneNumberId, row.voipPhoneNumberId),
  );
}

export async function upsertPhoneNumberRegistry(
  env: TelnyxEnv,
  args: {
    phoneNumber: string;
    clerkOrgId: string;
    voipPhoneNumberId: string;
    isActive?: boolean;
  },
): Promise<void> {
  const masterDb = getMasterDb(env);
  const now = new Date();
  const phoneNumber = normalizeE164(args.phoneNumber);

  const [existing] = await masterDb
    .select()
    .from(masterSchema.phoneNumberRegistry)
    .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, phoneNumber))
    .limit(1);

  if (existing) {
    await masterDb
      .update(masterSchema.phoneNumberRegistry)
      .set({
        clerkOrgId: args.clerkOrgId,
        voipPhoneNumberId: args.voipPhoneNumberId,
        isActive: args.isActive ?? true,
        updatedAt: now,
      })
      .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, phoneNumber));
    return;
  }

  await masterDb.insert(masterSchema.phoneNumberRegistry).values({
    phoneNumber,
    clerkOrgId: args.clerkOrgId,
    voipPhoneNumberId: args.voipPhoneNumberId,
    isActive: args.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  });
}

/** Switch the caller's own entry off (a hosted number that was deleted). Another workspace's entry is left alone. */
export async function deactivatePhoneNumberRegistry(env: TelnyxEnv, row: OwnRegistryRow): Promise<void> {
  const masterDb = getMasterDb(env);
  await masterDb
    .update(masterSchema.phoneNumberRegistry)
    .set({ isActive: false, updatedAt: new Date() })
    .where(ownRow(row));
}

/**
 * Let go of a number on a customer's own phone system: the caller's own entry
 * is deleted, so the claim leaves nothing behind. Another workspace's entry is
 * left alone.
 */
export async function releasePhoneNumberRegistry(env: TelnyxEnv, row: OwnRegistryRow): Promise<void> {
  const masterDb = getMasterDb(env);
  await masterDb.delete(masterSchema.phoneNumberRegistry).where(ownRow(row));
}

/**
 * Claim a number for a customer's own phone system, in one conditional write.
 * True when the number was free, or the existing entry is this workspace's own
 * and names this row or one of `reclaimIds` (rows of this workspace the caller
 * found soft-deleted or gone). An entry of another workspace, active or not,
 * holds the number: false, and nothing is written.
 */
export async function claimPhoneNumberRegistry(
  env: TelnyxEnv,
  row: OwnRegistryRow & { reclaimIds?: string[] },
): Promise<boolean> {
  const r = masterSchema.phoneNumberRegistry;
  const now = new Date();
  const claimed = await getMasterDb(env)
    .insert(r)
    .values({
      phoneNumber: normalizeE164(row.phoneNumber),
      clerkOrgId: row.clerkOrgId,
      voipPhoneNumberId: row.voipPhoneNumberId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: r.phoneNumber,
      set: { voipPhoneNumberId: row.voipPhoneNumberId, isActive: true, updatedAt: now },
      setWhere: and(
        eq(r.clerkOrgId, row.clerkOrgId),
        inArray(r.voipPhoneNumberId, [row.voipPhoneNumberId, ...(row.reclaimIds ?? [])]),
      ),
    })
    .returning({ phoneNumber: r.phoneNumber });
  return claimed.length > 0;
}

export async function lookupPhoneNumberRegistry(
  masterDb: MasterDatabase,
  phoneNumber: string,
): Promise<{
  phoneNumber: string;
  clerkOrgId: string;
  voipPhoneNumberId: string;
} | null> {
  const [row] = await masterDb
    .select()
    .from(masterSchema.phoneNumberRegistry)
    .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, normalizeE164(phoneNumber)))
    .limit(1);

  if (!row?.isActive) return null;
  return {
    phoneNumber: row.phoneNumber,
    clerkOrgId: row.clerkOrgId,
    voipPhoneNumberId: row.voipPhoneNumberId,
  };
}

/** Normalize to E.164-ish form (digits with leading +). */
export function normalizeE164(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) {
    return `+${trimmed.slice(1).replace(/\D/g, '')}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+${digits}` : trimmed;
}
