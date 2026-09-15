import 'server-only';

import { asc } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';
import { isDefaultTelephonyPricing } from '@/lib/phone-pricing-keys';

const { telephonyNumberPricing } = masterSchema;

export interface PhonePricingRow {
  id: string;
  countryCode: string;
  numberType: string;
  monthlyPrice: string;
  currency: string;
  isActive: boolean;
  markupAmount: number | null;
  markupPercent: string | null;
  stripePriceId: string | null;
  updatedAt: string;
}

export interface PhonePricingDefault {
  id: string;
  markupAmount: number | null;
  markupPercent: string | null;
}

function serialize(row: typeof telephonyNumberPricing.$inferSelect): PhonePricingRow {
  return {
    id: row.id,
    countryCode: row.countryCode,
    numberType: row.numberType,
    monthlyPrice: String(row.monthlyPrice),
    currency: row.currency,
    isActive: row.isActive,
    markupAmount: row.markupAmount,
    markupPercent: row.markupPercent != null ? String(row.markupPercent) : null,
    stripePriceId: row.stripePriceId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPhonePricing(): Promise<{
  rows: PhonePricingRow[];
  defaultMarkup: PhonePricingDefault | null;
}> {
  const db = getMasterDb();
  const all = await db
    .select()
    .from(telephonyNumberPricing)
    .orderBy(asc(telephonyNumberPricing.countryCode), asc(telephonyNumberPricing.numberType));
  const defaultRow = all.find((r) => isDefaultTelephonyPricing(r.countryCode, r.numberType));
  return {
    rows: all.filter((r) => !isDefaultTelephonyPricing(r.countryCode, r.numberType)).map(serialize),
    defaultMarkup: defaultRow
      ? {
          id: defaultRow.id,
          markupAmount: defaultRow.markupAmount,
          markupPercent: defaultRow.markupPercent != null ? String(defaultRow.markupPercent) : null,
        }
      : null,
  };
}

export async function listExistingPhonePricingKeys(): Promise<
  Array<{
    id: string;
    countryCode: string;
    numberType: string;
    markupAmount: number | null;
    markupPercent: string | null;
  }>
> {
  const db = getMasterDb();
  return db
    .select({
      id: telephonyNumberPricing.id,
      countryCode: telephonyNumberPricing.countryCode,
      numberType: telephonyNumberPricing.numberType,
      markupAmount: telephonyNumberPricing.markupAmount,
      markupPercent: telephonyNumberPricing.markupPercent,
    })
    .from(telephonyNumberPricing);
}
