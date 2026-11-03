/**
 * Rows the route tests start from: personal accounts in the master database
 * and the personal database's tables, cleared before each test.
 */

import { inArray } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as personalSchema from '@weldsuite/db/schema/personal';

/** The signed-in user of {@link sessionToken} and their personal account. */
export const USER = 'user_personal';
export const ACCOUNT = 'pa_personal';
/** Another person, whose rows must never show up. */
export const OTHER_USER = 'user_other';
export const OTHER_ACCOUNT = 'pa_other';

export const AT = new Date('2026-10-01T09:00:00.000Z');

type MasterDb = PgliteDatabase<typeof masterSchema>;
type PersonalDb = PgliteDatabase<typeof personalSchema>;

/** Every personal table, children first. */
const PERSONAL_TABLES = [
  personalSchema.personalMailAttachments,
  personalSchema.personalMailSubscriptions,
  personalSchema.personalMailDrafts,
  personalSchema.personalMailLabels,
  personalSchema.personalMailMessages,
  personalSchema.personalMailAccounts,
  personalSchema.personalCalendarBookings,
  personalSchema.personalCalendarBookingPages,
  personalSchema.personalCalendarEvents,
  personalSchema.personalCalendars,
  personalSchema.personalDeviceTokens,
];

/** Empty personal tables and no personal accounts for the test users. */
export async function resetDatabases(masterDb: MasterDb, personalDb: PersonalDb, users: string[] = [USER, OTHER_USER]) {
  for (const table of PERSONAL_TABLES) await personalDb.delete(table);
  await masterDb.delete(masterSchema.mailAccountRegistry);
  await masterDb.delete(masterSchema.personalAccounts).where(inArray(masterSchema.personalAccounts.clerkUserId, users));
}

/** The master `personal_accounts` row of a user. */
export async function seedPersonalAccount(
  masterDb: MasterDb,
  row: { id?: string; clerkUserId?: string; displayName?: string | null } = {},
) {
  await masterDb.insert(masterSchema.personalAccounts).values({
    id: row.id ?? ACCOUNT,
    clerkUserId: row.clerkUserId ?? USER,
    displayName: row.displayName === undefined ? 'Pat Personal' : row.displayName,
    isActive: true,
    createdAt: AT,
    updatedAt: AT,
  });
}

/** The signed-in user's account and the other person's. */
export async function seedBothAccounts(masterDb: MasterDb) {
  await seedPersonalAccount(masterDb);
  await seedPersonalAccount(masterDb, { id: OTHER_ACCOUNT, clerkUserId: OTHER_USER, displayName: 'Olly Other' });
}
