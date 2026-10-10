'use server';

import { revalidatePath } from 'next/cache';
import {
  PLAN_COUNTRY_PRICING_KEY,
  normalizeCountryCode,
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
import { getPlanCountryPricing } from '@/lib/plan-pricing-data';

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

/**
 * Write the whole `billing.plan_country_pricing` setting. app-api and the
 * marketing site cache it for about five minutes, so a change shows there
 * within that window.
 */
async function writeConfig(config: PlanCountryPricingConfig, updatedBy: string): Promise<void> {
  await getMasterDb()
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
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, category: 'billing', dataType: 'json', updatedBy, updatedAt: new Date() },
    });
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
    const { config } = await getPlanCountryPricing();
    if (previous !== parsed.country && config.countries[parsed.country]) {
      return { ok: false, error: fill(copy.countryExists, { country: parsed.country }) };
    }
    const countries = { ...config.countries };
    if (previous) delete countries[previous];
    countries[parsed.country] = parsed.pricing;
    await writeConfig({ countries }, guard.identity.email);
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
    const { config } = await getPlanCountryPricing();
    if (!config.countries[code]) return { ok: true, data: { country: code } };
    const countries = { ...config.countries };
    delete countries[code];
    await writeConfig({ countries }, guard.identity.email);
  } catch {
    return { ok: false, error: copy.saveFailed };
  }

  revalidatePath('/plan-pricing');
  return { ok: true, data: { country: code } };
}
