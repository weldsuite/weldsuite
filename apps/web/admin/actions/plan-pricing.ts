'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  PLAN_COUNTRY_PRICING_KEY,
  normalizeCountryCode,
  parsePlanCountryPricing,
  type PlanCountryPricingConfig,
} from '@weldsuite/app-api-client/schemas/plan-country-pricing';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { adminPlanPricingCopy, fill } from '@/lib/i18n';
import {
  parseCountryPricingInput,
  type CountryPricingInput,
  type PlanPricingErrorCode,
} from '@/lib/plan-pricing';
import { readPlanCountryPricingRow, type PlanCountryPricingRow } from '@/lib/plan-pricing-data';

const { systemSettings } = masterSchema;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function inputError(code: PlanPricingErrorCode, plan?: string): string {
  const copy = adminPlanPricingCopy();
  const planName = plan ? copy.plans[plan as keyof typeof copy.plans] : '';
  switch (code) {
    case 'country_invalid':
      return copy.countryInvalid;
    case 'currency_invalid':
      return copy.currencyInvalid;
    case 'annual_without_monthly':
      return fill(copy.annualWithoutMonthly, { plan: planName });
    case 'annual_above_monthly':
      return fill(copy.annualAboveMonthly, { plan: planName });
    default:
      return fill(copy.priceInvalid, { plan: planName });
  }
}

/** How often a save re-reads and retries after another admin's write got in between. */
const MAX_WRITE_ATTEMPTS = 5;

type ConfigChange = { write: PlanCountryPricingConfig } | { unchanged: true } | { error: string };

/**
 * Apply `change` to the `billing.plan_country_pricing` setting without losing
 * a concurrent edit. The admin console has no interactive transactions
 * (Neon HTTP), so this is a compare-and-set: the write only lands when the
 * stored value is still the one `change` was computed from, and otherwise
 * re-reads and recomputes. Two admins editing different countries at once
 * therefore both keep their change.
 *
 * app-api and the marketing site cache the setting for about five minutes,
 * so a change shows there within that window.
 */
async function updateConfig(
  change: (config: PlanCountryPricingConfig) => ConfigChange,
  updatedBy: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const current = await readPlanCountryPricingRow();
    const next = change(parsePlanCountryPricing(current?.value));
    if ('error' in next) return { ok: false, error: next.error };
    if ('unchanged' in next) return { ok: true };
    if (await writeConfigIfUnchanged(current, next.write, updatedBy)) return { ok: true };
  }
  throw new Error('plan country pricing kept changing during the save');
}

/** Write `config` only when the row still holds `expected`. Returns whether it was written. */
async function writeConfigIfUnchanged(
  expected: PlanCountryPricingRow | null,
  config: PlanCountryPricingConfig,
  updatedBy: string,
): Promise<boolean> {
  const db = getMasterDb();
  if (!expected) {
    const inserted = await db
      .insert(systemSettings)
      .values({
        id: generateId('set'),
        key: PLAN_COUNTRY_PRICING_KEY,
        category: 'billing',
        dataType: 'json',
        value: config,
        description: 'Plan prices per country (Business, Scale, Enterprise). Countries not listed: on request.',
        updatedBy,
      })
      .onConflictDoNothing({ target: systemSettings.key })
      .returning({ id: systemSettings.id });
    return inserted.length > 0;
  }

  // jsonb equality is semantic (key order, whitespace), so this matches the
  // row exactly when nobody wrote it since it was read.
  const sameValue =
    expected.value === null || expected.value === undefined
      ? isNull(systemSettings.value)
      : sql`${systemSettings.value} = ${JSON.stringify(expected.value)}::jsonb`;
  const updated = await db
    .update(systemSettings)
    .set({ value: config, category: 'billing', dataType: 'json', updatedBy, updatedAt: new Date() })
    .where(and(eq(systemSettings.key, PLAN_COUNTRY_PRICING_KEY), sameValue))
    .returning({ id: systemSettings.id });
  return updated.length > 0;
}

/**
 * Add or replace one country's prices. `previousCountry` is the code the
 * dialog was opened for, so changing the code in the dialog moves the entry
 * instead of leaving the old one behind.
 */
export async function saveCountryPlanPricing(
  input: CountryPricingInput,
  previousCountry: string | null,
): Promise<ActionResult<{ country: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parseCountryPricingInput(input);
  if (!parsed.ok) return { ok: false, error: inputError(parsed.code, parsed.plan) };

  const copy = adminPlanPricingCopy();
  const previous = normalizeCountryCode(previousCountry);
  try {
    const result = await updateConfig((config) => {
      if (previous !== parsed.country && config.countries[parsed.country]) {
        return { error: fill(copy.countryExists, { country: parsed.country }) };
      }
      const countries = { ...config.countries };
      if (previous) delete countries[previous];
      countries[parsed.country] = parsed.pricing;
      return { write: { countries } };
    }, guard.identity.email);
    if (!result.ok) return result;
  } catch {
    return { ok: false, error: copy.saveFailed };
  }

  revalidatePath('/plan-pricing');
  return { ok: true, data: { country: parsed.country } };
}

/** Remove a country: its visitors see "On request" again. */
export async function removeCountryPlanPricing(country: string): Promise<ActionResult<{ country: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const copy = adminPlanPricingCopy();
  const code = normalizeCountryCode(country);
  if (!code) return { ok: false, error: copy.countryInvalid };
  try {
    const result = await updateConfig((config) => {
      if (!config.countries[code]) return { unchanged: true };
      const countries = { ...config.countries };
      delete countries[code];
      return { write: { countries } };
    }, guard.identity.email);
    if (!result.ok) return result;
  } catch {
    return { ok: false, error: copy.saveFailed };
  }

  revalidatePath('/plan-pricing');
  return { ok: true, data: { country: code } };
}
