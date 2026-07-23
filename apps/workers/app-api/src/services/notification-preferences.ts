/**
 * Notification preferences — singleton-per-user record with upsert semantics.
 *
 * Ported from apps/api-worker/src/routes/settings/index.ts (W5b of the
 * legacy-worker phase-out). Pure functions, no Hono context.
 *
 * Two things make this table unlike app-api's generated per-row CRUD shells:
 *
 *  1. **It is a singleton per user.** `notification_preferences` carries a
 *     UNIQUE index on `user_id`, so "create vs. update" is not a caller
 *     decision — the caller just states its desired preferences and the server
 *     writes the one row that may or may not exist yet. Both legacy branches
 *     (select → insert | update) collapse into a single atomic
 *     `INSERT ... ON CONFLICT (user_id) DO UPDATE`, which also closes the
 *     read-then-write race the legacy route had (two concurrent first writes
 *     raced to insert and one lost with a unique violation).
 *
 *  2. **`modulePreferences` is merged, not replaced.** Toggling one module must
 *     leave the other modules untouched, so the merge happens server-side in
 *     the JSONB (`existing || patch`) rather than by making the client
 *     read-modify-write the whole column.
 *
 * The tenant DB is already per-workspace and this table carries no
 * `workspaceId` column, so `userId` is the complete scoping predicate.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db';
import { schema } from '../db';
import { generateId } from '../lib/id';

const t = schema.notificationPreferences;

export type NotificationPreferenceRow = typeof t.$inferSelect;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * NOTE: these deliberately do NOT reuse
 * `@weldsuite/core-api-client/schemas/notification-preferences`. That schema
 * requires `channel` + `notificationType` — columns that do not exist on
 * `notification_preferences` (it describes a different table), which made every
 * write against it either 400 on validation or silently drop the field. The
 * shapes below are derived from the actual Drizzle table and mirror the legacy
 * api-worker validators, which are the live contract.
 */

/** One module's channel fan-out. All five flags are required (legacy parity). */
export const moduleChannelPreferencesSchema = z.object({
  enabled: z.boolean(),
  inApp: z.boolean(),
  email: z.boolean(),
  push: z.boolean(),
  desktop: z.boolean(),
});

/**
 * Partial by design: the settings UI toggles one switch at a time and sends
 * only that key (e.g. `{ defaultInApp: false }`). Anything omitted is left
 * as-is on an existing row, and falls back to the legacy create-defaults on the
 * user's first write.
 */
export const upsertNotificationPreferencesSchema = z.object({
  doNotDisturb: z.boolean().optional(),
  soundEnabled: z.boolean().optional(),
  modulePreferences: z.record(moduleChannelPreferencesSchema).optional(),
  defaultInApp: z.boolean().optional(),
  defaultEmail: z.boolean().optional(),
  defaultPush: z.boolean().optional(),
  defaultDesktop: z.boolean().optional(),
});

export type ModuleChannelPreferencesInput = z.infer<typeof moduleChannelPreferencesSchema>;
export type UpsertNotificationPreferencesInput = z.infer<typeof upsertNotificationPreferencesSchema>;

/**
 * Module keys are user-supplied path segments that become JSONB object keys.
 * The value is parameterised (so this is not an injection surface), but keeping
 * the key a plain slug stops junk keys from accumulating in the column. Left
 * open rather than pinned to today's module list so a new module does not need
 * a backend change.
 */
export const moduleNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/i);

/** Legacy create-time defaults, applied only when the user has no row yet. */
const CREATE_DEFAULTS = {
  doNotDisturb: false,
  soundEnabled: true,
  modulePreferences: {},
  defaultInApp: true,
  defaultEmail: false,
  defaultPush: true,
  defaultDesktop: true,
} as const;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Drop keys the caller never sent so a partial PUT stays a merge, not a wipe. */
function definedOnly(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Upsert the caller's preference row.
 *
 * Insert path applies the legacy create-defaults for anything omitted; update
 * path touches only the keys actually sent.
 */
export async function upsertNotificationPreferences(
  db: Database,
  userId: string,
  input: UpsertNotificationPreferencesInput,
): Promise<NotificationPreferenceRow> {
  const now = new Date();
  const patch = definedOnly(input);

  const [row] = await db
    .insert(t)
    .values({
      id: generateId('npr'),
      userId,
      ...CREATE_DEFAULTS,
      ...patch,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert)
    .onConflictDoUpdate({
      target: t.userId,
      // Only the sent keys — CREATE_DEFAULTS must never reach an existing row
      // or a single `{ doNotDisturb: true }` would reset every other setting.
      set: { ...patch, updatedAt: now },
    })
    .returning();

  return row;
}

/**
 * Merge one module's channel prefs into the `modulePreferences` JSONB,
 * server-side, leaving every other module untouched.
 *
 * `existing || patch` replaces just this module's object, which is exactly the
 * legacy `{ ...currentModulePrefs, [moduleName]: prefs }` semantic — but done
 * in one statement, so concurrent toggles on two modules cannot clobber each
 * other the way the legacy read-modify-write could.
 */
export async function mergeModulePreferences(
  db: Database,
  userId: string,
  moduleName: string,
  prefs: ModuleChannelPreferencesInput,
): Promise<NotificationPreferenceRow> {
  const now = new Date();
  const patch = { [moduleName]: prefs };

  const [row] = await db
    .insert(t)
    .values({
      id: generateId('npr'),
      userId,
      modulePreferences: patch,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert)
    .onConflictDoUpdate({
      target: t.userId,
      set: {
        modulePreferences: sql`COALESCE(${t.modulePreferences}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: now,
      },
    })
    .returning();

  return row;
}
