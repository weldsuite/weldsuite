/**
 * Handles porting-order terminal states fired by the Telnyx webhook.
 *
 * Ported verbatim from apps/api-worker/src/lib/porting-completion.ts (W3
 * legacy phase-out) — now lives in services/ per app-api conventions.
 *
 * On 'completed': insert a voipPhoneNumbers row in the workspace's tenant DB
 * (idempotent — webhook may fire twice), link it to the porting order,
 * notify the creating user, and clear the master-DB index entry.
 *
 * On 'exception': leave the porting order intact (so the user can retry or
 * support can intervene), notify the user, and KEEP the master index row
 * (Telnyx may still send follow-ups).
 *
 * On 'cancelled': mark cancelled, delete master index row.
 *
 * Billing was already triggered at submit-time (matches the existing new-
 * purchase flow), so this handler does NOT call the billing worker. If
 * the port fails post-billing, that's an admin refund — same edge case
 * the new-purchase flow already lives with.
 */

import { eq } from 'drizzle-orm';
import {
  getTenantDbForWorkspace,
  getMasterDb,
  schema,
  masterSchema,
  type Database,
} from '../db';
import { generateId } from '../lib/id';
import { getPortingOrder } from '../lib/telnyx-porting';
import type { TelnyxEnv } from '../lib/telnyx';

interface CompletionContext {
  env: TelnyxEnv;
  /** Clerk org id — the key the tenant DB resolver expects. */
  clerkOrgId: string;
  draftId: string;
  telnyxOrderId: string;
}

export async function handlePortingCompleted(ctx: CompletionContext): Promise<void> {
  const { env, clerkOrgId, draftId, telnyxOrderId } = ctx;
  const db = await getTenantDbForWorkspace(env, clerkOrgId);

  // Re-fetch from Telnyx so we have the assigned phone_number_id (the
  // status_changed payload doesn't always include it).
  const order = await getPortingOrder(env, telnyxOrderId);

  // Take the first number on the order. v1 only allows single-number
  // ports; we still defensive-check to avoid surfacing weird state.
  const portedNumber = order.phoneNumbers[0];
  if (!portedNumber) {
    await markOrderError(db, draftId, 'completed_without_number', 'Telnyx reported completion but returned no phone number');
    return;
  }

  // Look up the existing porting order so we have the user, country, etc.
  const [draft] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(eq(schema.voipPortingOrders.id, draftId))
    .limit(1);

  if (!draft) {
    // Tenant DB doesn't have the draft — most likely a webhook replay
    // after we already deleted/cancelled. Acknowledge silently.
    return;
  }

  // Idempotency: if voipPhoneNumberId is already set, this is a replay.
  if (draft.voipPhoneNumberId) return;

  // Idempotency on the underlying phone_numbers table — the unique index
  // on phoneNumber means a parallel run would error. Check first.
  const [existingNumber] = await db
    .select({ id: schema.voipPhoneNumbers.id })
    .from(schema.voipPhoneNumbers)
    .where(eq(schema.voipPhoneNumbers.phoneNumber, draft.phoneNumber))
    .limit(1);

  let voipPhoneNumberId: string;
  if (existingNumber) {
    voipPhoneNumberId = existingNumber.id;
  } else {
    voipPhoneNumberId = generateId('vpn');
    await db.insert(schema.voipPhoneNumbers).values({
      id: voipPhoneNumberId,
      provider: 'telnyx',
      phoneNumber: draft.phoneNumber,
      formattedNumber: draft.formattedNumber ?? draft.phoneNumber,
      countryCode: draft.countryCode,
      numberType: draft.numberType ?? 'local',
      providerPhoneNumberId: portedNumber.id ?? null,
      providerConnectionId: env.TELNYX_CONNECTION_ID ?? null,
      status: 'active',
      isDefault: false,
      allowInbound: true,
      allowOutbound: true,
      enableRecording: true,
      displayName: draft.businessName ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Mark the draft completed and link.
  await db
    .update(schema.voipPortingOrders)
    .set({
      status: 'completed',
      voipPhoneNumberId,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.voipPortingOrders.id, draftId));

  // In-app notification to the user who started the port.
  await insertNotification(db, {
    userId: draft.createdByUserId,
    title: 'Your number is now live',
    body: `${draft.formattedNumber ?? draft.phoneNumber} has been ported into WeldSuite and is ready to use.`,
    entityType: 'voip_phone_number',
    entityId: voipPhoneNumberId,
    actionUrl: '/settings/apps/phone-numbers',
    icon: 'phone',
    severity: 'success',
    notificationType: 'system_update',
    category: 'system',
  });

  // Cleanup master index — terminal state, no more webhooks expected.
  await getMasterDb(env)
    .delete(masterSchema.telnyxPortingOrderIndex)
    .where(eq(masterSchema.telnyxPortingOrderIndex.telnyxPortingOrderId, telnyxOrderId));
}

export async function handlePortingException(ctx: CompletionContext, message: string): Promise<void> {
  const { env, clerkOrgId, draftId } = ctx;
  const db = await getTenantDbForWorkspace(env, clerkOrgId);

  const [draft] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(eq(schema.voipPortingOrders.id, draftId))
    .limit(1);
  if (!draft) return;

  await db
    .update(schema.voipPortingOrders)
    .set({
      status: 'exception',
      lastErrorCode: 'telnyx_exception',
      lastErrorMessage: message,
      updatedAt: new Date(),
    })
    .where(eq(schema.voipPortingOrders.id, draftId));

  await insertNotification(db, {
    userId: draft.createdByUserId,
    title: 'Port request needs attention',
    body: `Telnyx flagged a problem on the port for ${draft.formattedNumber ?? draft.phoneNumber}: ${message || 'no detail provided'}.`,
    entityType: 'voip_porting_order',
    entityId: draft.id,
    actionUrl: `/settings/apps/phone-numbers/port/${draft.id}`,
    icon: 'phone',
    severity: 'warning',
    notificationType: 'custom',
    category: 'system',
  });

  // Keep master index row — Telnyx may still resolve and re-fire status.
}

export async function handlePortingCancelled(ctx: CompletionContext): Promise<void> {
  const { env, clerkOrgId, draftId, telnyxOrderId } = ctx;
  const db = await getTenantDbForWorkspace(env, clerkOrgId);

  await db
    .update(schema.voipPortingOrders)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(schema.voipPortingOrders.id, draftId));

  await getMasterDb(env)
    .delete(masterSchema.telnyxPortingOrderIndex)
    .where(eq(masterSchema.telnyxPortingOrderIndex.telnyxPortingOrderId, telnyxOrderId));
}

// ----------------------------------------------------------------------------

async function markOrderError(db: Database, draftId: string, code: string, message: string): Promise<void> {
  await db
    .update(schema.voipPortingOrders)
    .set({
      lastErrorCode: code,
      lastErrorMessage: message,
      updatedAt: new Date(),
    })
    .where(eq(schema.voipPortingOrders.id, draftId));
}

async function insertNotification(
  db: Database,
  args: {
    userId: string;
    title: string;
    body: string;
    entityType: string;
    entityId: string;
    actionUrl: string;
    icon: string;
    severity: 'info' | 'success' | 'warning' | 'error';
    notificationType: string;
    category: string;
  },
): Promise<void> {
  try {
    await db.insert(schema.notifications).values({
      id: generateId('ntf'),
      userId: args.userId,
      title: args.title,
      body: args.body,
      category: args.category,
      notificationType: args.notificationType,
      entityType: args.entityType,
      entityId: args.entityId,
      actionUrl: args.actionUrl,
      icon: args.icon,
      severity: args.severity,
      isRead: false,
      deliveredInApp: true,
      deliveredEmail: false,
      deliveredPush: false,
      createdAt: new Date(),
    });
  } catch (err) {
    // Notification failure must not bubble — webhook needs to 200 either
    // way to avoid Telnyx retries.
    console.error('[Porting] Failed to insert notification:', err);
  }
}
