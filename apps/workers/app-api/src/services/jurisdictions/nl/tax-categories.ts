import type { TaxCategoryTemplate } from '../types';

/**
 * Standard Dutch BTW rates, seeded on NL entity creation.
 * `jurisdictionMetadata.btwRubriek` drives the BTW return XBRL mapping.
 *
 * 2026 rate landscape: 21% hoog / 9% laag / 0% remain correct. Per 1 Jan 2026
 * logies (short-stay accommodation) moved from 9% to 21% — a categorization
 * concern for the booking user, not a rate-table change (culture/media/sport/
 * books KEPT 9% after parliament reversed the planned abolition; camping
 * pitches stay 9%).
 */
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
    jurisdictionMetadata: { btwRubriek: '1c' },
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
    rate: '0.00',
    type: 'purchase',
    taxCategoryCode: 'reverse_charge',
    jurisdictionMetadata: { btwRubriek: '2a' },
  },
  {
    name: 'BTW Intracommunautair',
    rate: '0.00',
    type: 'sales',
    taxCategoryCode: 'eu_b2b_service',
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
