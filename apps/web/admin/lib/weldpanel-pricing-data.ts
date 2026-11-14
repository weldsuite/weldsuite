import '@tanstack/react-start/server-only';

import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';
import { DEFAULT_PANEL_PRICING, WELDPANEL_PRICING_KEY, resolveStoredPricing, type PanelPricing } from './weldpanel-pricing';

const { systemSettings } = masterSchema;

export interface WeldpanelPricingView {
  /** Rates panel-api charges right now (saved row, or the defaults). */
  effective: PanelPricing;
  /** Built-in defaults, used when the row is absent. */
  defaults: PanelPricing;
  /** True when a `weldpanel.pricing` row exists. */
  isCustom: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function getWeldpanelPricing(): Promise<WeldpanelPricingView> {
  const db = getMasterDb();
  const [row] = await db
    .select({
      value: systemSettings.value,
      updatedAt: systemSettings.updatedAt,
      updatedBy: systemSettings.updatedBy,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, WELDPANEL_PRICING_KEY))
    .limit(1);

  return {
    effective: resolveStoredPricing(row?.value),
    defaults: { ...DEFAULT_PANEL_PRICING },
    isCustom: Boolean(row),
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedBy ?? null,
  };
}
