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
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { updateStripeCustomer } from '@weldsuite/stripe';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';

const { workspaceSettings } = schema;

type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;

/**
 * Columns that may be written from the request body — the allowlist IS the
 * mapping. The request schema is strict and lists exactly these keys, so an
 * unknown key (the legacy `name`, `locale`, `logo`, `settings`) is a 400 at
 * the validator instead of a 200 that stores nothing. Keep this list and
 * `updateWorkspaceSettingsInput` in
 * packages/clients/app-api-client/src/schemas/workspace-settings.ts in step.
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
 * Project the validated body onto real columns. `null` is a meaningful value
 * here (clearing the logo), so
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
  /** The default legal entity carries the Stripe mirror (see `mirrorStripeCustomer`); only sync the digest. */
  skipStripe?: boolean;
}

async function syncDigestTimezone(
  masterDb: MasterDatabase,
  workspaceId: string,
  timezone: string,
): Promise<void> {
  try {
    await masterDb
      .update(masterSchema.digestSchedules)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(masterSchema.digestSchedules.workspaceId, workspaceId));
  } catch (err) {
    console.error('[app-api/workspace-settings] digest timezone sync failed:', err);
  }
}

/** What the Stripe customer mirrors: the invoice name, email and address of the business. */
export interface StripeCustomerProfile {
  name?: string;
  email?: string;
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
}

/** The Stripe profile of a settings save: only the fields the body carries. */
export function stripeProfileFromSettings(data: UpdateWorkspaceSettingsInput): StripeCustomerProfile {
  return {
    name: data.legalName || data.tradingName || undefined,
    email: data.email || undefined,
    address: {
      line1: data.addressLine1 || undefined,
      line2: data.addressLine2 || undefined,
      city: data.city || undefined,
      state: data.state || undefined,
      postalCode: data.postalCode || undefined,
      country: data.country || undefined,
    },
  };
}

async function syncStripeCustomer(
  stripeSecretKey: string,
  stripeCustomerId: string,
  profile: StripeCustomerProfile,
): Promise<void> {
  try {
    await updateStripeCustomer(stripeSecretKey, stripeCustomerId, {
      ...(profile.name && { name: profile.name }),
      ...(profile.email && { email: profile.email }),
      address: {
        ...(profile.address.line1 && { line1: profile.address.line1 }),
        ...(profile.address.line2 && { line2: profile.address.line2 }),
        ...(profile.address.city && { city: profile.address.city }),
        ...(profile.address.state && { state: profile.address.state }),
        ...(profile.address.postalCode && { postal_code: profile.address.postalCode }),
        ...(profile.address.country && { country: profile.address.country }),
      },
    });
  } catch (err) {
    console.error('[app-api/workspace-settings] Stripe customer sync failed:', err);
  }
}

/**
 * Push a business profile onto the workspace's Stripe customer. Best-effort:
 * failures are logged, never thrown. Shared by the settings save and by every
 * change to the default legal entity (docs/plans/legal-entities.md).
 */
export async function mirrorStripeCustomer(params: {
  masterDb: MasterDatabase;
  /** `workspaces.id` or the Clerk org id (`matchWorkspaceRef` takes either). */
  workspaceRef: string;
  profile: StripeCustomerProfile;
  stripeSecretKey?: string;
}): Promise<void> {
  if (!params.stripeSecretKey) return;
  try {
    const [workspace] = await params.masterDb
      .select({ stripeCustomerId: masterSchema.workspaces.stripeCustomerId })
      .from(masterSchema.workspaces)
      .where(matchWorkspaceRef(params.workspaceRef))
      .limit(1);
    if (!workspace?.stripeCustomerId) return;
    await syncStripeCustomer(params.stripeSecretKey, workspace.stripeCustomerId, params.profile);
  } catch (err) {
    console.error('[app-api/workspace-settings] Stripe mirror failed:', err);
  }
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
  skipStripe,
}: SyncBillingMirrorParams): Promise<void> {
  try {
    const [workspace] = await masterDb
      .select({
        id: masterSchema.workspaces.id,
        stripeCustomerId: masterSchema.workspaces.stripeCustomerId,
      })
      .from(masterSchema.workspaces)
      .where(matchWorkspaceRef(clerkOrgId))
      .limit(1);

    if (!workspace) return;

    // Digest cron reads the timezone from master, so keep it in step.
    if (data.timezone) {
      await syncDigestTimezone(masterDb, workspace.id, data.timezone);
    }

    // Stripe invoices render the legal entity + address from the customer.
    if (!skipStripe && workspace.stripeCustomerId && stripeSecretKey) {
      await syncStripeCustomer(stripeSecretKey, workspace.stripeCustomerId, stripeProfileFromSettings(data));
    }
  } catch (err) {
    console.error('[app-api/workspace-settings] billing mirror sync failed:', err);
  }
}
