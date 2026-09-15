/**
 * Order a Telnyx number and persist it on the tenant — only after Stripe
 * has already taken payment (domain-registration pattern).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema } from '../db';
import { generateId } from '../lib/id';
import { upsertPhoneNumberRegistry } from '../lib/phone-registry';
import { isTelnyxConfigured, telnyxRequest, type TelnyxEnv } from '../lib/telnyx';

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
}

interface TelnyxNumberOrderResponse {
  data?: {
    id?: string;
    status?: string;
    phone_numbers?: Array<{
      id?: string;
      phone_number?: string;
      status?: string;
    }>;
  };
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

  if (existing?.status === 'active' && existing.providerPhoneNumberId) {
    try {
      await upsertPhoneNumberRegistry(env, {
        phoneNumber,
        clerkOrgId: input.clerkOrgId,
        voipPhoneNumberId: existing.id,
        isActive: true,
      });
    } catch (regErr) {
      console.error('[PhoneOrder] Registry upsert on already-active number failed:', regErr);
    }
    return { id: existing.id, alreadyFulfilled: true };
  }

  const voipId = input.voipPhoneNumberId || existing?.id || generateId('vpn');
  const connectionId = env.TELNYX_CONNECTION_ID;

  const orderBody: Record<string, unknown> = {
    phone_numbers: [{ phone_number: phoneNumber }],
    customer_reference: voipId,
  };
  if (connectionId) orderBody.connection_id = connectionId;

  const order = await telnyxRequest<TelnyxNumberOrderResponse>(env, '/number_orders', {
    method: 'POST',
    body: JSON.stringify(orderBody),
  });

  const ordered = order.data?.phone_numbers?.find((n) => n.phone_number === phoneNumber)
    ?? order.data?.phone_numbers?.[0];

  const now = new Date();
  const row = {
    provider: 'telnyx' as const,
    phoneNumber,
    formattedNumber: input.friendlyName || existing?.formattedNumber || phoneNumber,
    countryCode: input.countryCode.toUpperCase(),
    numberType: input.numberType,
    status: 'active' as const,
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
      isActive: true,
    });
  } catch (regErr) {
    console.error('[PhoneOrder] Failed to register number for inbound routing:', regErr);
  }

  return { id: existing?.id ?? voipId, alreadyFulfilled: false };
}
