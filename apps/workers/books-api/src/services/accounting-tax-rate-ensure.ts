/**
 * Bring an existing entity's seeded tax rates up to the current template.
 *
 * Standard rates are seeded once, when an entity is created, so an entity that
 * pre-dates a change to the template never sees it. This runs lazily (from the
 * tax-rate list, which every picker uses) and is idempotent: it only touches
 * what is still missing or still has the old seed values, matched on the
 * rate's name and category so a rate the user changed or created is left alone.
 *
 * Dutch (NL) entities:
 *   - "ICL goederen" (eu_b2b_goods, box 3b) is added: intracommunautaire
 *     leveringen of goods are reported on the ICP as goods, not as services.
 *   - "BTW Intracommunautair" is renamed to "BTW Intracommunautair diensten".
 *   - "BTW Laag 9%" moves from box '1c' (the old, wrong number) to '1b'.
 *   - "BTW Verlegd" (domestic reverse charge) gets the 21% the buyer owes, so
 *     box 2a shows the BTW; it was seeded at 0%.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  NL_EU_SERVICES_RATE_NAME,
  NL_ICL_GOODS_RATE_NAME,
  NL_LEGACY_EU_RATE_NAME,
  nlTaxCategories,
} from '@weldsuite/books-domain/jurisdictions/nl';

type TaxRateRow = typeof schema.taxRates.$inferSelect;

export interface EnsureTaxRatesResult {
  created: number;
  updated: number;
}

/** What `ensureNlTaxRates` would do for a set of rates: pure, so it can be tested without a database. */
export function planNlTaxRateUpdates(rates: TaxRateRow[]): {
  create: Array<(typeof nlTaxCategories)[number]>;
  update: Array<{ id: string; set: Partial<Pick<TaxRateRow, 'name' | 'rate' | 'jurisdictionMetadata'>> }>;
} {
  const plan = { create: [] as Array<(typeof nlTaxCategories)[number]>, update: [] as Array<{ id: string; set: Partial<Pick<TaxRateRow, 'name' | 'rate' | 'jurisdictionMetadata'>> }> };

  // An entity created without defaults has none of the standard rates: leave it alone.
  if (!rates.some((r) => r.name === 'BTW Hoog 21%')) return plan;

  const hasName = (name: string) => rates.some((r) => r.name === name);

  for (const rate of rates) {
    const meta = (rate.jurisdictionMetadata ?? {}) as Record<string, unknown>;

    if (rate.name === NL_LEGACY_EU_RATE_NAME && rate.taxCategoryCode === 'eu_b2b_service' && !hasName(NL_EU_SERVICES_RATE_NAME)) {
      plan.update.push({ id: rate.id, set: { name: NL_EU_SERVICES_RATE_NAME } });
    }
    if (rate.taxCategoryCode === 'reduced' && meta.btwRubriek === '1c') {
      plan.update.push({ id: rate.id, set: { jurisdictionMetadata: { ...meta, btwRubriek: '1b' } } });
    }
    if (rate.name === 'BTW Verlegd' && rate.taxCategoryCode === 'reverse_charge' && Number(rate.rate) === 0) {
      plan.update.push({ id: rate.id, set: { rate: '21.0000' } });
    }
  }

  if (!rates.some((r) => r.taxCategoryCode === 'eu_b2b_goods')) {
    const template = nlTaxCategories.find((t) => t.name === NL_ICL_GOODS_RATE_NAME);
    if (template) plan.create.push(template);
  }
  return plan;
}

export async function ensureStandardTaxRates(db: Database, entityId: string): Promise<EnsureTaxRatesResult> {
  const result: EnsureTaxRatesResult = { created: 0, updated: 0 };

  const [entity] = await db
    .select({ jurisdictionCode: schema.entities.jurisdictionCode })
    .from(schema.entities)
    .where(eq(schema.entities.id, entityId))
    .limit(1);
  if (entity?.jurisdictionCode !== 'NL') return result;

  const rates = await db
    .select()
    .from(schema.taxRates)
    .where(and(eq(schema.taxRates.entityId, entityId), isNull(schema.taxRates.deletedAt)));

  const plan = planNlTaxRateUpdates(rates);
  const now = new Date();

  for (const { id, set } of plan.update) {
    await db
      .update(schema.taxRates)
      .set({ ...set, updatedAt: now })
      .where(and(eq(schema.taxRates.id, id), eq(schema.taxRates.entityId, entityId)));
    result.updated += 1;
  }

  if (plan.create.length > 0) {
    await db.insert(schema.taxRates).values(
      plan.create.map((t) => ({
        id: generateId('txr'),
        entityId,
        jurisdictionCode: 'NL',
        name: t.name,
        rate: t.rate,
        type: t.type,
        taxCategoryCode: t.taxCategoryCode,
        isDefault: t.isDefault ?? false,
        isActive: t.isActive ?? true,
        jurisdictionMetadata: t.jurisdictionMetadata,
        createdAt: now,
        updatedAt: now,
      })),
    );
    result.created += plan.create.length;
  }
  return result;
}
