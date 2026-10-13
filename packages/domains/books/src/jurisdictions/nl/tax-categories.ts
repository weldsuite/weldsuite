import type { TaxCategoryTemplate } from '../types';

/**
 * Standard Dutch BTW rates, seeded on NL entity creation.
 * `jurisdictionMetadata.btwRubriek` drives the BTW return XBRL mapping, using
 * the official box numbers of the aangifte: 1a hoog, 1b laag, 1c overige
 * tarieven, 1e 0% / niet belast, 2a verlegd binnenland, 3a uitvoer, 3b
 * binnen de EU, 4a / 4b verwervingen, 5b voorbelasting.
 *
 * Existing entities get later additions and corrections through
 * `ensureNlStandardTaxRates` (books-api), which matches on the rate name.
 *
 * 2026 rate landscape: 21% hoog / 9% laag / 0% remain correct. Per 1 Jan 2026
 * logies (short-stay accommodation) moved from 9% to 21% — a categorization
 * concern for the booking user, not a rate-table change (culture/media/sport/
 * books KEPT 9% after parliament reversed the planned abolition; camping
 * pitches stay 9%).
 */
/** The sales rate for services to EU business customers (was "BTW Intracommunautair"). */
export const NL_EU_SERVICES_RATE_NAME = 'BTW Intracommunautair diensten';
/** The sales rate for intracommunautaire leveringen of goods. */
export const NL_ICL_GOODS_RATE_NAME = 'BTW ICL goederen';
/** Name the services rate had before goods got a rate of their own. */
export const NL_LEGACY_EU_RATE_NAME = 'BTW Intracommunautair';

export const nlTaxCategories: TaxCategoryTemplate[] = [
  {
    name: 'BTW Hoog 21%',
    rate: '21.00',
    type: 'both',
    taxCategoryCode: 'standard',
    isDefault: true,
    jurisdictionMetadata: { btwRubriek: '1a' },
  },
  {
    name: 'BTW Laag 9%',
    rate: '9.00',
    type: 'both',
    taxCategoryCode: 'reduced',
    jurisdictionMetadata: { btwRubriek: '1b' },
  },
  {
    name: 'BTW Nul 0%',
    rate: '0.00',
    type: 'both',
    taxCategoryCode: 'zero',
    jurisdictionMetadata: { btwRubriek: '1e' },
  },
  {
    name: 'BTW Verlegd',
    // The buyer owes the BTW itself (box 2a BTW), so the rate is the one of the supply.
    rate: '21.00',
    type: 'purchase',
    taxCategoryCode: 'reverse_charge',
    jurisdictionMetadata: { btwRubriek: '2a' },
  },
  {
    // Services to an EU business customer: BTW verlegd (art. 44 / 196 BTW-richtlijn), box 3b, ICP "diensten".
    name: NL_EU_SERVICES_RATE_NAME,
    rate: '0.00',
    type: 'sales',
    taxCategoryCode: 'eu_b2b_service',
    jurisdictionMetadata: { btwRubriek: '3b' },
  },
  {
    // Goods to an EU business customer: intracommunautaire levering 0% (art. 138 BTW-richtlijn), box 3b, ICP "leveringen".
    name: NL_ICL_GOODS_RATE_NAME,
    rate: '0.00',
    type: 'sales',
    taxCategoryCode: 'eu_b2b_goods',
    jurisdictionMetadata: { btwRubriek: '3b' },
  },
  {
    name: 'BTW Export buiten EU',
    rate: '0.00',
    type: 'sales',
    taxCategoryCode: 'export_goods',
    jurisdictionMetadata: { btwRubriek: '3a' },
  },
  {
    name: 'BTW Inkoop EU',
    rate: '21.00',
    type: 'purchase',
    taxCategoryCode: 'eu_b2b_service',
    jurisdictionMetadata: { btwRubriek: '4b' },
  },
  {
    name: 'BTW Inkoop buiten EU',
    rate: '21.00',
    type: 'purchase',
    taxCategoryCode: 'import_goods',
    jurisdictionMetadata: { btwRubriek: '4a' },
  },
  {
    name: 'BTW Voorbelasting 21%',
    rate: '21.00',
    type: 'purchase',
    taxCategoryCode: 'standard',
    jurisdictionMetadata: { btwRubriek: '5b' },
  },
  {
    name: 'BTW Voorbelasting 9%',
    rate: '9.00',
    type: 'purchase',
    taxCategoryCode: 'reduced',
    jurisdictionMetadata: { btwRubriek: '5b' },
  },
];
