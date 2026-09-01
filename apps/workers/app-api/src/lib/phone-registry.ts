/**
 * Master DB phone_number → clerkOrgId registry for inbound Telnyx routing.
 */

import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema, type MasterDatabase } from '../db';
import type { TelnyxEnv } from './telnyx';

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

export async function deactivatePhoneNumberRegistry(
  env: TelnyxEnv,
  phoneNumber: string,
): Promise<void> {
  const masterDb = getMasterDb(env);
  await masterDb
    .update(masterSchema.phoneNumberRegistry)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, normalizeE164(phoneNumber)));
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

  if (!row || !row.isActive) return null;
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
