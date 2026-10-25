/** Workspace defaults for new envelopes (`sign_settings`, one row per workspace). */

import { schema, type Database } from '@weldsuite/worker-kit/db';

/** Used until a workspace saves its own settings; the same as the table's column defaults. */
export const SIGN_DEFAULTS = {
  expiryDays: 30,
  reminderAfterDays: 3,
  reminderEveryDays: 3,
  reminderMaxCount: 3,
} as const;

export interface SignDefaults {
  expiryDays: number | null;
  reminderAfterDays: number | null;
  reminderEveryDays: number | null;
  reminderMaxCount: number | null;
}

/** The signer-facing brand the workspace set for WeldSign; nulls fall back to the workspace. */
export async function loadSignBrand(db: Database): Promise<{ name: string | null; color: string | null; logoUrl: string | null }> {
  const [row] = await db.select().from(schema.signSettings).limit(1);
  return { name: row?.brandName ?? null, color: row?.brandColor ?? null, logoUrl: row?.brandLogoUrl ?? null };
}

export async function loadSignSettings(db: Database): Promise<SignDefaults> {
  const [row] = await db.select().from(schema.signSettings).limit(1);
  if (!row) return { ...SIGN_DEFAULTS };
  return {
    expiryDays: row.defaultExpiryDays,
    reminderAfterDays: row.defaultReminderAfterDays,
    reminderEveryDays: row.defaultReminderEveryDays,
    reminderMaxCount: row.defaultReminderMaxCount,
  };
}
