'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { parseMarkupInput, parsePriceMajor, type MarkupPatch } from '@/lib/domain-pricing-markup';
import { adminPhonePricingCopy } from '@/lib/i18n';
import {
  DEFAULT_PHONE_PRICING_COUNTRY,
  DEFAULT_PHONE_PRICING_TYPE,
  parseCountryCode,
  parseNumberType,
} from '@/lib/phone-pricing-keys';

const { telephonyNumberPricing } = masterSchema;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function refresh(): void {
  revalidatePath('/phone-pricing');
  revalidatePath('/');
}

function markupError(code: 'invalid' | 'out_of_range'): string {
  const copy = adminPhonePricingCopy();
  return code === 'out_of_range' ? copy.markupOutOfRange : copy.markupInvalid;
}

async function persistMarkup(
  patch: MarkupPatch,
  opts: { id?: string; onlyEmpty?: boolean; includeDefault?: boolean } = {},
): Promise<number> {
  const db = getMasterDb();
  const values = {
    markupAmount: patch.markupAmount,
    markupPercent: patch.markupPercent,
    updatedAt: new Date(),
  };

  if (opts.id) {
    const updated = await db
      .update(telephonyNumberPricing)
      .set(values)
      .where(eq(telephonyNumberPricing.id, opts.id))
      .returning({ id: telephonyNumberPricing.id });
    return updated.length;
  }

  if (opts.onlyEmpty) {
    const updated = await db
      .update(telephonyNumberPricing)
      .set(values)
      .where(
        and(isNull(telephonyNumberPricing.markupAmount), isNull(telephonyNumberPricing.markupPercent)),
      )
      .returning({ id: telephonyNumberPricing.id });
    return updated.length;
  }

  const updated = await db
    .update(telephonyNumberPricing)
    .set(values)
    .returning({ id: telephonyNumberPricing.id });
  return updated.length;
}

async function upsertDefaultMarkup(patch: MarkupPatch): Promise<void> {
  const db = getMasterDb();
  const [existing] = await db
    .select({ id: telephonyNumberPricing.id })
    .from(telephonyNumberPricing)
    .where(
      and(
        eq(telephonyNumberPricing.countryCode, DEFAULT_PHONE_PRICING_COUNTRY),
        eq(telephonyNumberPricing.numberType, DEFAULT_PHONE_PRICING_TYPE),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(telephonyNumberPricing)
      .set({
        markupAmount: patch.markupAmount,
        markupPercent: patch.markupPercent,
        updatedAt: new Date(),
      })
      .where(eq(telephonyNumberPricing.id, existing.id));
    return;
  }

  await db.insert(telephonyNumberPricing).values({
    id: generateId('tnp'),
    countryCode: DEFAULT_PHONE_PRICING_COUNTRY,
    numberType: DEFAULT_PHONE_PRICING_TYPE,
    monthlyPrice: '0',
    setupFee: '0',
    currency: 'USD',
    provider: 'telnyx',
    isActive: true,
    markupAmount: patch.markupAmount,
    markupPercent: patch.markupPercent,
  });
}

export async function updatePhonePricingMarkup(
  id: string,
  input: { kind: string; value: string },
): Promise<ActionResult<{ id: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parseMarkupInput(input.kind, input.value);
  if (!parsed.ok) return { ok: false, error: markupError(parsed.code) };

  const updated = await persistMarkup(parsed.data, { id });
  if (!updated) return { ok: false, error: adminPhonePricingCopy().markupNotFound };

  refresh();
  return { ok: true, data: { id } };
}

export async function applyPhonePricingMarkup(input: {
  kind: string;
  value: string;
  onlyEmpty?: boolean;
}): Promise<ActionResult<{ updated: number }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parseMarkupInput(input.kind, input.value);
  if (!parsed.ok) return { ok: false, error: markupError(parsed.code) };

  const updated = await persistMarkup(parsed.data, { onlyEmpty: Boolean(input.onlyEmpty) });
  await upsertDefaultMarkup(parsed.data);
  refresh();
  return { ok: true, data: { updated: Math.max(updated, 1) } };
}

export async function updatePhonePricingWholesale(
  id: string,
  input: { monthlyPrice: string },
): Promise<ActionResult<{ id: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parsePriceMajor(input.monthlyPrice);
  if (!parsed.ok) {
    const copy = adminPhonePricingCopy();
    return { ok: false, error: parsed.code === 'out_of_range' ? copy.priceOutOfRange : copy.priceInvalid };
  }

  const db = getMasterDb();
  const updated = await db
    .update(telephonyNumberPricing)
    .set({ monthlyPrice: parsed.value, updatedAt: new Date() })
    .where(eq(telephonyNumberPricing.id, id))
    .returning({ id: telephonyNumberPricing.id });
  if (!updated.length) return { ok: false, error: adminPhonePricingCopy().markupNotFound };

  refresh();
  return { ok: true, data: { id } };
}

export async function createPhonePricing(input: {
  countryCode: string;
  numberType: string;
  monthlyPrice: string;
}): Promise<ActionResult<{ id: string; countryCode: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const copy = adminPhonePricingCopy();
  const country = parseCountryCode(input.countryCode);
  if (!country.ok) return { ok: false, error: copy.countryInvalid };
  const type = parseNumberType(input.numberType);
  if (!type.ok) return { ok: false, error: copy.typeInvalid };
  const monthlyPrice = parsePriceMajor(input.monthlyPrice);
  if (!monthlyPrice.ok) {
    return { ok: false, error: monthlyPrice.code === 'out_of_range' ? copy.priceOutOfRange : copy.priceInvalid };
  }

  const db = getMasterDb();
  const created = await db
    .insert(telephonyNumberPricing)
    .values({
      id: generateId('tnp'),
      countryCode: country.countryCode,
      numberType: type.numberType,
      monthlyPrice: monthlyPrice.value,
      setupFee: '0',
      currency: 'USD',
      provider: 'telnyx',
      isActive: true,
    })
    .onConflictDoNothing({
      target: [telephonyNumberPricing.countryCode, telephonyNumberPricing.numberType],
    })
    .returning({ id: telephonyNumberPricing.id, countryCode: telephonyNumberPricing.countryCode });
  if (!created[0]) return { ok: false, error: copy.createDuplicate };

  refresh();
  return { ok: true, data: created[0] };
}
