/**
 * Workspace settings service — the `workspace_settings` business blob.
 *
 * Pure functions over the tenant + master DBs (no Hono context). Ported from
 * apps/api-worker `GET|PUT /settings/workspace`, which app-api never carried:
 * the existing /api/workspace-settings surface only did name/slug/delete.
 *
 * The legacy PUT did three things, all reproduced here:
 *   1. upsert the singleton tenant row,
 *   2. mirror `timezone` into the master `digest_schedules` row so the digest
 *      cron fans out at the right local hour,
 *   3. push the business/address details onto the Stripe customer so invoices
 *      carry the right legal entity.
 *
 * (2) and (3) are best-effort in the legacy route — a Stripe outage must not
 * lose the user's settings save — so they are isolated here and their failures
 * are logged, never thrown.
 */

import { eq, isNull } from 'drizzle-orm';
import type { UpdateWorkspaceSettingsInput } from '@weldsuite/app-api-client/schemas/workspace-settings';
import { masterSchema, schema, type Database, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';
import { updateStripeCustomer } from '../lib/stripe';

const { workspaceSettings } = schema;

type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;

/**
 * Columns that may be written from the request body — the allowlist IS the
 * mapping. Anything the schema accepts but that is absent here (`name`,
 * `locale`, `logo`, `settings`) has no backing column and is dropped, exactly
 * as the legacy route's `...data` spread dropped it.
 *
 * `settings` in particular is NOT mapped onto `customSettings`: that column
 * holds the PrintNode integration config, and folding an arbitrary `settings`
 * bag into it would clobber it. See the schema's note in
 * packages/clients/app-api-client/src/schemas/workspace-settings.ts.
 */
const WRITABLE_BLOB_FIELDS = [
  'theme',
  'timezone',
  'currency',
  'language',
  'dateFormat',
  'timeFormat',
  'legalName',
  'tradingName',
  'contactFirstName',
  'contactLastName',
  'email',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  'vatNumber',
  'registrationNumber',
  'logoUrl',
  'websiteUrl',
  'primaryColor',
  'accentColor',
  'customSettings',
] as const;

/** Read the singleton settings row. Returns null when the tenant never saved one. */
export async function getWorkspaceSettings(db: Database): Promise<WorkspaceSettingsRow | null> {
  const [row] = await db
    .select()
    .from(workspaceSettings)
    .where(isNull(workspaceSettings.deletedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Project the validated body onto real columns, dropping the accepted-and-
 * ignored fields. `null` is a meaningful value here (clearing the logo), so
 * only `undefined` is skipped.
 */
function toColumnValues(data: UpdateWorkspaceSettingsInput): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of WRITABLE_BLOB_FIELDS) {
    const value = (data as Record<string, unknown>)[field];
    if (value !== undefined) values[field] = value;
  }
  return values;
}

export interface UpsertWorkspaceSettingsResult {
  row: WorkspaceSettingsRow;
  /** True when no row existed and one was inserted (legacy answered 201). */
  created: boolean;
}

/** Upsert the singleton settings row. */
export async function upsertWorkspaceSettings(
  db: Database,
  data: UpdateWorkspaceSettingsInput,
): Promise<UpsertWorkspaceSettingsResult> {
  const values = toColumnValues(data);
  const now = new Date();

  const existing = await getWorkspaceSettings(db);

  if (existing) {
    await db
      .update(workspaceSettings)
      .set({ ...values, updatedAt: now })
      .where(eq(workspaceSettings.id, existing.id));

    const [updated] = await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.id, existing.id))
      .limit(1);

    return { row: updated, created: false };
  }

  const id = generateId('ws');
  await db.insert(workspaceSettings).values({
    id,
    ...values,
    createdAt: now,
    updatedAt: now,
  } as typeof workspaceSettings.$inferInsert);

  const [created] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, id))
    .limit(1);

  return { row: created, created: true };
}

/**
 * True when the payload touches anything the master DB / Stripe mirror cares
 * about. Mirrors the legacy `hasBillingFields` check exactly.
 */
export function touchesBillingMirror(data: UpdateWorkspaceSettingsInput): boolean {
  return Boolean(
    data.legalName ||
      data.tradingName ||
      data.email ||
      data.addressLine1 ||
      data.city ||
      data.postalCode ||
      data.country ||
      data.timezone,
  );
}

export interface SyncBillingMirrorParams {
  masterDb: MasterDatabase;
  clerkOrgId: string;
  data: UpdateWorkspaceSettingsInput;
  stripeSecretKey?: string;
}

/**
 * Fan the settings save out to the master `digest_schedules` row and the Stripe
 * customer. Best-effort end to end: every failure is logged and swallowed so a
 * downstream outage can never lose the tenant's settings write.
 */
export async function syncBillingMirror({
  masterDb,
  clerkOrgId,
  data,
  stripeSecretKey,
}: SyncBillingMirrorParams): Promise<void> {
  try {
    const [workspace] = await masterDb
      .select({
        id: masterSchema.workspaces.id,
        stripeCustomerId: masterSchema.workspaces.stripeCustomerId,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
      .limit(1);

    if (!workspace) return;

    // Digest cron reads the timezone from master, so keep it in step.
    if (data.timezone) {
      try {
        await masterDb
          .update(masterSchema.digestSchedules)
          .set({ timezone: data.timezone, updatedAt: new Date() })
          .where(eq(masterSchema.digestSchedules.workspaceId, workspace.id));
      } catch (err) {
        console.error('[app-api/workspace-settings] digest timezone sync failed:', err);
      }
    }

    // Stripe invoices render the legal entity + address from the customer.
    if (workspace.stripeCustomerId && stripeSecretKey) {
      try {
        const customerName = data.legalName || data.tradingName || undefined;
        await updateStripeCustomer(stripeSecretKey, workspace.stripeCustomerId, {
          ...(customerName && { name: customerName }),
          ...(data.email && { email: data.email }),
          address: {
            ...(data.addressLine1 && { line1: data.addressLine1 }),
            ...(data.addressLine2 && { line2: data.addressLine2 }),
            ...(data.city && { city: data.city }),
            ...(data.state && { state: data.state }),
            ...(data.postalCode && { postal_code: data.postalCode }),
            ...(data.country && { country: data.country }),
          },
        });
      } catch (err) {
        console.error('[app-api/workspace-settings] Stripe customer sync failed:', err);
      }
    }
  } catch (err) {
    console.error('[app-api/workspace-settings] billing mirror sync failed:', err);
  }
}
