import 'server-only';

import { eq } from 'drizzle-orm';
import {
  PLAN_COUNTRY_PRICING_KEY,
  parsePlanCountryPricing,
  type PlanCountryPricingConfig,
} from '@weldsuite/app-api-client/schemas/plan-country-pricing';
import { getMasterDb, masterSchema } from './db';

const { systemSettings } = masterSchema;

export interface PlanPricingView {
  config: PlanCountryPricingConfig;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlanCountryPricingRow {
  /** The stored value as-is, unparsed: the save actions compare against it. */
  value: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

/** The `billing.plan_country_pricing` row, `null` when nothing has been saved yet. */
export async function readPlanCountryPricingRow(): Promise<PlanCountryPricingRow | null> {
  const [row] = await getMasterDb()
    .select({
      value: systemSettings.value,
      updatedAt: systemSettings.updatedAt,
      updatedBy: systemSettings.updatedBy,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, PLAN_COUNTRY_PRICING_KEY))
    .limit(1);
  return row ?? null;
}

/** The saved per-country price list (empty when nothing has been saved yet). */
export async function getPlanCountryPricing(): Promise<PlanPricingView> {
  const row = await readPlanCountryPricingRow();
  return {
    config: parsePlanCountryPricing(row?.value),
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedBy ?? null,
  };
}
