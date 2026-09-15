/**
 * Resolve the customer monthly price for a phone number: Telnyx wholesale
 * plus admin markup (WeldHost-style), falling back to the catalog row.
 */

import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema } from '../db';
import {
  applyTelephonyMarkupMajor,
  mapTelnyxAvailableNumber,
  normalizeNumberType,
  resolveTelephonyMarkup,
  type TelephonyMarkup,
} from '../lib/telnyx-available-numbers';
import { telnyxRequest, type TelnyxEnv } from '../lib/telnyx';

export interface ResolvedPhonePrice {
  wholesaleMajor: string;
  monthlyPrice: string;
  currency: string;
  stripePriceId?: string;
  stripeProductId?: string;
  markup: TelephonyMarkup;
}

function hasMarkup(markup: TelephonyMarkup | undefined): boolean {
  if (!markup) return false;
  return markup.markupAmount != null || markup.markupPercent != null;
}

export async function lookupTelnyxWholesale(
  env: TelnyxEnv,
  phoneNumber: string,
  countryCode: string,
): Promise<{ monthly: string; currency: string } | null> {
  const params = new URLSearchParams();
  params.set('filter[country_code]', countryCode.toUpperCase());
  params.set('filter[limit]', '20');
  params.set('filter[features][]', 'voice');
  const national = phoneNumber.replace(/^\+/, '');
  params.set('filter[phone_number][contains]', national.slice(-8));

  const resp = await telnyxRequest<{ data: unknown[] }>(
    env,
    `/available_phone_numbers?${params.toString()}`,
  );
  const mapped = (resp.data || [])
    .map((row) => mapTelnyxAvailableNumber(row as never, countryCode))
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const hit = mapped.find((n) => n.phone_number === phoneNumber) ?? mapped[0];
  const monthly = hit?.cost_information?.monthly_cost;
  if (!monthly) return null;
  const n = Number.parseFloat(monthly);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { monthly, currency: hit.cost_information?.currency || 'USD' };
}

export async function resolveCustomerPhonePrice(
  env: TelnyxEnv,
  args: { countryCode: string; numberType: string; phoneNumber: string },
): Promise<ResolvedPhonePrice | null> {
  const masterDb = getMasterDb(env);
  const rows = await masterDb
    .select()
    .from(masterSchema.telephonyNumberPricing)
    .where(eq(masterSchema.telephonyNumberPricing.isActive, true));

  const country = args.countryCode.toUpperCase();
  const type = normalizeNumberType(args.numberType);
  const catalog = rows.find(
    (r) => r.countryCode.toUpperCase() === country && normalizeNumberType(r.numberType) === type,
  );
  const markup = resolveTelephonyMarkup(rows, country, type) ?? {
    markupAmount: catalog?.markupAmount ?? null,
    markupPercent: catalog?.markupPercent != null ? String(catalog.markupPercent) : null,
  };

  let wholesaleMajor = catalog?.monthlyPrice != null ? String(catalog.monthlyPrice) : null;
  let currency = catalog?.currency || 'USD';

  if (!wholesaleMajor || Number.parseFloat(wholesaleMajor) <= 0) {
    const live = await lookupTelnyxWholesale(env, args.phoneNumber, country);
    if (live) {
      wholesaleMajor = live.monthly;
      currency = live.currency;
    }
  }

  if (!wholesaleMajor) return null;
  const monthlyPrice = applyTelephonyMarkupMajor(wholesaleMajor, markup) ?? wholesaleMajor;
  const cents = Math.round(Number.parseFloat(monthlyPrice) * 100);
  if (!Number.isFinite(cents) || cents < 1) return null;

  const useCatalogStripe = Boolean(catalog?.stripePriceId) && !hasMarkup(markup);

  return {
    wholesaleMajor,
    monthlyPrice,
    currency,
    stripePriceId: useCatalogStripe ? catalog?.stripePriceId ?? undefined : undefined,
    stripeProductId: catalog?.stripeProductId ?? undefined,
    markup: markup ?? { markupAmount: null, markupPercent: null },
  };
}
