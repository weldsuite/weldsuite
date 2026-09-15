'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { parseMarkupInput, parsePriceMajor, type MarkupPatch } from '@/lib/domain-pricing-markup';
import { adminPhonePricingCopy } from '@/lib/i18n';
import { listExistingPhonePricingKeys } from '@/lib/phone-pricing-data';
import {
  DEFAULT_PHONE_PRICING_COUNTRY,
  DEFAULT_PHONE_PRICING_TYPE,
  isDefaultTelephonyPricing,
  parseCountryCode,
  parseNumberType,
} from '@/lib/phone-pricing-keys';
import {
  medianMonthlyCost,
  monthlyCostsFromAvailable,
  parseCoverageMap,
  seedCombosFromCoverage,
  type SeedCombo,
} from '@/lib/phone-pricing-seed';
import { getAdminTelnyxApiKey, telnyxAdminRequest } from '@/lib/telnyx';

const { telephonyNumberPricing } = masterSchema;

const INSERT_CHUNK = 80;
const SEED_SAMPLE_LIMIT = 10;
const SEED_CONCURRENCY = 4;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface SeedPhonePricingResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

function rowKey(countryCode: string, numberType: string): string {
  return `${countryCode.trim().toUpperCase()}:${numberType.trim().toLowerCase().replace(/_/g, '-')}`;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }
  const n = Math.min(Math.max(limit, 1), Math.max(items.length, 1));
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : n }, () => worker()));
  return out;
}

async function sampleWholesale(
  apiKey: string,
  combo: SeedCombo,
): Promise<{ monthlyPrice: string; currency: string } | null> {
  const params = new URLSearchParams();
  params.set('filter[country_code]', combo.countryCode);
  params.set('filter[phone_number_type]', combo.telnyxType);
  params.set('filter[features][]', 'voice');
  params.set('filter[limit]', String(SEED_SAMPLE_LIMIT));
  try {
    const resp = await telnyxAdminRequest<{ data?: unknown[] }>(
      apiKey,
      `/available_phone_numbers?${params.toString()}`,
    );
    const { costs, currency } = monthlyCostsFromAvailable(resp.data ?? []);
    const monthlyPrice = medianMonthlyCost(costs);
    if (!monthlyPrice) return null;
    const parsed = parsePriceMajor(monthlyPrice);
    if (!parsed.ok) return null;
    return { monthlyPrice: parsed.value, currency };
  } catch {
    return null;
  }
}

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

export async function seedPhonePricing(): Promise<ActionResult<SeedPhonePricingResult>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const copy = adminPhonePricingCopy();
  const apiKey = getAdminTelnyxApiKey();
  if (!apiKey) return { ok: false, error: copy.notConfigured };

  let coverageRaw: { data?: unknown };
  try {
    coverageRaw = await telnyxAdminRequest<{ data?: unknown }>(apiKey, '/country_coverage');
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : copy.seedFailed,
    };
  }

  const combos = seedCombosFromCoverage(parseCoverageMap(coverageRaw.data));
  const samples = await mapPool(combos, SEED_CONCURRENCY, async (combo) => ({
    combo,
    sample: await sampleWholesale(apiKey, combo),
  }));

  const priced = samples.filter(
    (row): row is { combo: SeedCombo; sample: { monthlyPrice: string; currency: string } } =>
      row.sample !== null,
  );

  const existing = await listExistingPhonePricingKeys();
  const existingByKey = new Map(existing.map((r) => [rowKey(r.countryCode, r.numberType), r]));
  const defaultRow = existing.find((r) => isDefaultTelephonyPricing(r.countryCode, r.numberType));
  const defaultMarkupAmount = defaultRow?.markupAmount ?? null;
  const defaultMarkupPercent = defaultRow?.markupPercent != null ? String(defaultRow.markupPercent) : null;

  const missing = priced.filter(({ combo }) => !existingByKey.has(rowKey(combo.countryCode, combo.numberType)));
  const toUpdate = priced.filter(({ combo }) => existingByKey.has(rowKey(combo.countryCode, combo.numberType)));

  const db = getMasterDb();
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK).map(({ combo, sample }) => ({
      id: generateId('tnp'),
      countryCode: combo.countryCode,
      numberType: combo.numberType,
      monthlyPrice: sample.monthlyPrice,
      setupFee: '0',
      currency: sample.currency,
      provider: 'telnyx',
      isActive: true,
      markupAmount: defaultMarkupAmount,
      markupPercent: defaultMarkupPercent,
    }));
    const created = await db
      .insert(telephonyNumberPricing)
      .values(chunk)
      .onConflictDoNothing({
        target: [telephonyNumberPricing.countryCode, telephonyNumberPricing.numberType],
      })
      .returning({ id: telephonyNumberPricing.id });
    inserted += created.length;
  }

  for (let i = 0; i < toUpdate.length; i += INSERT_CHUNK) {
    const chunk = toUpdate.slice(i, i + INSERT_CHUNK);
    const results = await Promise.all(
      chunk.map(({ combo, sample }) => {
        const row = existingByKey.get(rowKey(combo.countryCode, combo.numberType));
        if (!row) return Promise.resolve([] as Array<{ id: string }>);
        return db
          .update(telephonyNumberPricing)
          .set({
            monthlyPrice: sample.monthlyPrice,
            currency: sample.currency,
            provider: 'telnyx',
            updatedAt: new Date(),
          })
          .where(eq(telephonyNumberPricing.id, row.id))
          .returning({ id: telephonyNumberPricing.id });
      }),
    );
    updated += results.reduce((sum, rows) => sum + rows.length, 0);
  }

  refresh();
  return {
    ok: true,
    data: {
      fetched: priced.length,
      inserted,
      updated,
      skipped: combos.length - inserted - updated,
    },
  };
}
