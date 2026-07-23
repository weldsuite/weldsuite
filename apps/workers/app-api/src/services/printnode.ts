/**
 * PrintNode settings service — the `printnode` key inside the singleton
 * `workspace_settings.customSettings` JSONB blob.
 *
 * Ported from apps/api-worker `GET|PUT /settings/printnode` (W5b). PrintNode
 * has no table of its own: the legacy route stashed the integration config
 * (an `{ apiKey }` object) under `customSettings.printnode`, which is why
 * services/workspace-settings.ts deliberately refuses to map an arbitrary
 * `settings` bag onto `customSettings` — it would clobber this.
 *
 * Pure functions over the tenant DB, no Hono context.
 */

import { eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { workspaceSettings } = schema;

/** The config blob the platform stores. Free-form — legacy never validated it. */
export type PrintNodeSettings = Record<string, unknown>;

async function getSettingsRow(db: Database) {
  const [row] = await db
    .select({ id: workspaceSettings.id, customSettings: workspaceSettings.customSettings })
    .from(workspaceSettings)
    .where(isNull(workspaceSettings.deletedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Read the PrintNode config. Returns null when the workspace has never saved
 * one (or has no settings row at all) — same as legacy.
 */
export async function getPrintNodeSettings(db: Database): Promise<PrintNodeSettings | null> {
  const row = await getSettingsRow(db);
  const custom = (row?.customSettings as Record<string, unknown> | null) || {};
  return (custom.printnode as PrintNodeSettings | undefined) ?? null;
}

export interface UpsertPrintNodeResult {
  settings: PrintNodeSettings;
  /** True when no settings row existed and one was inserted (legacy answered 201). */
  created: boolean;
}

/**
 * Write the PrintNode config, preserving every other key in `customSettings`
 * (the legacy route spread the current blob before overwriting `printnode`;
 * dropping that spread would wipe unrelated integration config).
 */
export async function upsertPrintNodeSettings(
  db: Database,
  settings: PrintNodeSettings,
): Promise<UpsertPrintNodeResult> {
  const existing = await getSettingsRow(db);
  const now = new Date();

  if (existing) {
    const current = (existing.customSettings as Record<string, unknown> | null) || {};
    await db
      .update(workspaceSettings)
      .set({
        customSettings: { ...current, printnode: settings },
        updatedAt: now,
      })
      .where(eq(workspaceSettings.id, existing.id));

    return { settings, created: false };
  }

  await db.insert(workspaceSettings).values({
    id: generateId('ws'),
    customSettings: { printnode: settings },
    createdAt: now,
    updatedAt: now,
  });

  return { settings, created: true };
}
