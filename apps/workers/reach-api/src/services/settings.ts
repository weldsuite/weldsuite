/**
 * `reach_settings`: one row per workspace (sender identity for the email
 * footer, sending defaults, stop-on-reply scope, onboarding state).
 *
 * The row is created lazily on first read with a fixed id, so two requests that
 * race to create it converge on the same row instead of making two.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { ReachSettings, UpdateReachSettingsInput } from '@weldsuite/app-api-client/schemas/reach';

export const REACH_SETTINGS_ID = 'rset_default';

export type ReachSettingsRow = typeof schema.reachSettings.$inferSelect;

/** The workspace's settings row, created with the defaults on first use. */
export async function getOrCreateReachSettings(db: Database): Promise<ReachSettingsRow> {
  const [existing] = await db.select().from(schema.reachSettings).limit(1);
  if (existing) return existing;

  await db.insert(schema.reachSettings).values({ id: REACH_SETTINGS_ID }).onConflictDoNothing();
  const [created] = await db.select().from(schema.reachSettings).limit(1);
  if (!created) throw new Error('reach_settings row could not be created');
  return created;
}

export async function updateReachSettings(
  db: Database,
  input: UpdateReachSettingsInput,
  now: Date = new Date(),
): Promise<ReachSettingsRow> {
  const current = await getOrCreateReachSettings(db);
  const { completeOnboarding, ...fields } = input;

  const patch: Partial<typeof schema.reachSettings.$inferInsert> = { updatedAt: now };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  if (completeOnboarding && !current.onboardingCompletedAt) patch.onboardingCompletedAt = now;

  const [updated] = await db
    .update(schema.reachSettings)
    .set(patch)
    .where(eq(schema.reachSettings.id, current.id))
    .returning();
  return updated ?? current;
}

export function toReachSettingsDto(row: ReachSettingsRow): ReachSettings {
  return {
    id: row.id,
    senderCompanyName: row.senderCompanyName,
    senderAddress: row.senderAddress,
    optOutText: row.optOutText,
    defaultTimezone: row.defaultTimezone,
    defaultSendDays: row.defaultSendDays,
    defaultWindowStart: row.defaultWindowStart,
    defaultWindowEnd: row.defaultWindowEnd,
    defaultMailboxDailyCap: row.defaultMailboxDailyCap,
    stopOnReplyScope: row.stopOnReplyScope,
    onboardingCompletedAt: row.onboardingCompletedAt ? row.onboardingCompletedAt.toISOString() : null,
  };
}
