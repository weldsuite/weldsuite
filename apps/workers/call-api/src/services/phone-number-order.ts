/**
 * Order a Telnyx number and persist it on the tenant — only after Stripe
 * has already taken payment (domain-registration pattern).
 *
 * Regulatory documents are collected *after* this order: Telnyx bills the
 * number when the order is placed, then asks for docs on a pending order.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { upsertPhoneNumberRegistry } from '../lib/phone-registry';
import { verifyPaidPhoneCheckout, type StripeEnv } from '../lib/stripe-checkout';
import { isTelnyxConfigured, telnyxRequest, type TelnyxEnv } from '../lib/telnyx';
import {
  telnyxOrderNeedsDocuments,
  type TelnyxNumberOrder,
} from './phone-number-requirements';

export interface FulfillPaidPhoneNumberInput {
  clerkOrgId: string;
  phoneNumber: string;
  countryCode: string;
  numberType: string;
  addressId?: string;
  displayName?: string;
  friendlyName?: string;
  voipPhoneNumberId?: string;
}

export interface FulfillPaidPhoneNumberResult {
  id: string;
  alreadyFulfilled: boolean;
  status: 'active' | 'pending';
}

export async function fulfillPaidPhoneNumber(
  env: TelnyxEnv,
  input: FulfillPaidPhoneNumberInput,
): Promise<FulfillPaidPhoneNumberResult> {
  if (!isTelnyxConfigured(env)) {
    throw new Error('Phone service is not activated');
  }

  const phoneNumber = input.phoneNumber.trim();
  const db = await getTenantDbForWorkspace(env, input.clerkOrgId);
  const { voipPhoneNumbers } = schema;

  const [existing] = await db
    .select()
    .from(voipPhoneNumbers)
    .where(and(eq(voipPhoneNumbers.phoneNumber, phoneNumber), isNull(voipPhoneNumbers.deletedAt)))
    .limit(1);

  if (existing?.providerPhoneNumberId) {
    const status = existing.status === 'active' ? 'active' as const : 'pending' as const;
    try {
      await upsertPhoneNumberRegistry(env, {
        phoneNumber,
        clerkOrgId: input.clerkOrgId,
        voipPhoneNumberId: existing.id,
        isActive: status === 'active',
      });
    } catch (regErr) {
      console.error('[PhoneOrder] Registry upsert on existing number failed:', regErr);
    }
    return { id: existing.id, alreadyFulfilled: true, status };
  }

  const voipId = input.voipPhoneNumberId || existing?.id || generateId('vpn');
  const connectionId = env.TELNYX_CONNECTION_ID;

  const phoneEntry: Record<string, unknown> = { phone_number: phoneNumber };
  if (input.addressId) phoneEntry.address_id = input.addressId;

  const orderBody: Record<string, unknown> = {
    phone_numbers: [phoneEntry],
    customer_reference: voipId,
  };
  if (connectionId) orderBody.connection_id = connectionId;

  const order = await telnyxRequest<{ data?: TelnyxNumberOrder }>(env, '/number_orders', {
    method: 'POST',
    body: JSON.stringify(orderBody),
  });

  const ordered = order.data?.phone_numbers?.find((n) => n.phone_number === phoneNumber)
    ?? order.data?.phone_numbers?.[0];

  const needsDocs = telnyxOrderNeedsDocuments(order.data);
  const status = needsDocs ? 'pending' as const : 'active' as const;

  const now = new Date();
  const row = {
    provider: 'telnyx' as const,
    phoneNumber,
    formattedNumber: input.friendlyName || existing?.formattedNumber || phoneNumber,
    countryCode: input.countryCode.toUpperCase(),
    numberType: input.numberType,
    status,
    providerPhoneNumberId: ordered?.id ?? order.data?.id ?? null,
    providerConnectionId: connectionId ?? null,
    displayName: input.displayName ?? existing?.displayName ?? null,
    updatedAt: now,
  };

  if (existing) {
    await db.update(voipPhoneNumbers).set(row).where(eq(voipPhoneNumbers.id, existing.id));
  } else {
    await db.insert(voipPhoneNumbers).values({
      id: voipId,
      ...row,
      isDefault: false,
      allowInbound: true,
      allowOutbound: true,
      enableRecording: true,
      createdAt: now,
    });
  }

  try {
    await upsertPhoneNumberRegistry(env, {
      phoneNumber,
      clerkOrgId: input.clerkOrgId,
      voipPhoneNumberId: existing?.id ?? voipId,
      isActive: status === 'active',
    });
  } catch (regErr) {
    console.error('[PhoneOrder] Failed to register number for inbound routing:', regErr);
  }

  return { id: existing?.id ?? voipId, alreadyFulfilled: false, status };
}

// ---------------------------------------------------------------------------
// Payment-verified, idempotent entry point (used by /api/internal/telephony/
// fulfill-number). The order itself is `fulfillPaidPhoneNumber` above; this
// wrapper proves the payment first and makes a retried reference a no-op.
// ---------------------------------------------------------------------------

export interface FulfillCheckoutInput extends FulfillPaidPhoneNumberInput {
  /** Stripe Checkout Session id (`cs_...`) of the completed phone checkout. */
  checkoutSessionId: string;
}

const FULFILL_KEY_PREFIX = 'phone-fulfill:';
/** Longer than any Telnyx order call, so a crashed isolate frees the claim. */
const INFLIGHT_TTL_SECONDS = 120;
/** Keep the outcome long enough to cover every Stripe webhook retry window. */
const DONE_TTL_SECONDS = 60 * 60 * 24 * 90;

type FulfillRecord =
  | { state: 'inflight' }
  | { state: 'done'; result: FulfillPaidPhoneNumberResult };

export class PhoneFulfillInProgressError extends Error {
  constructor() {
    super('Fulfilment for this checkout is already in progress');
    this.name = 'PhoneFulfillInProgressError';
  }
}

async function readRecord(kv: KVNamespace, key: string): Promise<FulfillRecord | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FulfillRecord;
  } catch {
    return null;
  }
}

export async function fulfillPaidPhoneNumberForCheckout(
  env: TelnyxEnv & StripeEnv,
  input: FulfillCheckoutInput,
): Promise<FulfillPaidPhoneNumberResult> {
  const { checkoutSessionId, ...order } = input;

  // 1. Independent proof of payment: org + number must match the paid session.
  await verifyPaidPhoneCheckout(env, checkoutSessionId, {
    clerkOrgId: order.clerkOrgId,
    phoneNumber: order.phoneNumber,
    countryCode: order.countryCode,
    numberType: order.numberType,
  });

  // 2. Idempotent on the payment reference: a retry returns the first result
  //    instead of buying again. (A number already present on the tenant is also
  //    returned as `alreadyFulfilled` by fulfillPaidPhoneNumber, which covers a
  //    lost KV record.)
  const key = `${FULFILL_KEY_PREFIX}${checkoutSessionId}`;
  const existing = await readRecord(env.WORKSPACE_CACHE, key);
  if (existing?.state === 'done') return { ...existing.result, alreadyFulfilled: true };
  if (existing?.state === 'inflight') throw new PhoneFulfillInProgressError();

  await env.WORKSPACE_CACHE.put(key, JSON.stringify({ state: 'inflight' } satisfies FulfillRecord), {
    expirationTtl: INFLIGHT_TTL_SECONDS,
  });

  try {
    const result = await fulfillPaidPhoneNumber(env, order);
    await env.WORKSPACE_CACHE.put(key, JSON.stringify({ state: 'done', result } satisfies FulfillRecord), {
      expirationTtl: DONE_TTL_SECONDS,
    });
    return result;
  } catch (err) {
    // Let the caller's retry try again; the tenant-row check guards a
    // half-completed order.
    await env.WORKSPACE_CACHE.delete(key).catch(() => undefined);
    throw err;
  }
}
