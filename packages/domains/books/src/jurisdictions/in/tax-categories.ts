import type { GstSlabMetadata, TaxCategoryTemplate } from '../types';

function gstSlabMeta(
  slab: string,
  halfRate: string,
  fullRate: string,
): GstSlabMetadata {
  return {
    gstSlab: slab,
    components: {
      intrastate: [
        { code: 'cgst', rate: halfRate, accountRole: 'tax_output_cgst' },
        { code: 'sgst', rate: halfRate, accountRole: 'tax_output_sgst' },
      ],
      interstate: [
        { code: 'igst', rate: fullRate, accountRole: 'tax_output_igst' },
      ],
    },
  };
}

/**
 * Standard Indian GST rates seeded on IN entity creation.
 *
 * Since the 22 Sept 2025 rationalisation the general slabs are 5% and 18%
 * (plus 40% on demerit and luxury goods), with 3% on gold and silver and 0.25%
 * on rough diamonds. The old 12% and 28% slabs are still seeded so documents
 * dated before the change can be entered, but switched off (`isActive: false`)
 * and flagged `legacy` in their metadata.
 *
 * Display names are English to match the entity default locale (`en-IN`),
 * mirroring how the NL adapter seeds Dutch names for `nl-NL`.
 * `jurisdictionMetadata.components` drives CGST+SGST (intra-state) vs IGST
 * (inter-state) expansion at posting time. Seeded roles are tax_output_*;
 * purchase expansion remaps to tax_input_*.
 */
export const inTaxCategories: TaxCategoryTemplate[] = [
  {
    name: 'GST 18%',
    rate: '18.00',
    type: 'both',
    taxCategoryCode: 'standard',
    isDefault: true,
    jurisdictionMetadata: gstSlabMeta('18', '9.00', '18.00') as unknown as Record<string, unknown>,
  },
  {
    name: 'GST 5%',
    rate: '5.00',
    type: 'both',
    taxCategoryCode: 'super_reduced',
    jurisdictionMetadata: gstSlabMeta('5', '2.50', '5.00') as unknown as Record<string, unknown>,
  },
  {
    name: 'GST 40%',
    rate: '40.00',
    type: 'both',
    taxCategoryCode: 'standard',
    jurisdictionMetadata: gstSlabMeta('40', '20.00', '40.00') as unknown as Record<string, unknown>,
  },
  {
    name: 'GST 3% (gold, silver)',
    rate: '3.00',
    type: 'both',
    taxCategoryCode: 'reduced',
    jurisdictionMetadata: gstSlabMeta('3', '1.50', '3.00') as unknown as Record<string, unknown>,
  },
  {
    name: 'GST 0.25% (rough diamonds)',
    rate: '0.25',
    type: 'both',
    taxCategoryCode: 'super_reduced',
    jurisdictionMetadata: gstSlabMeta('0.25', '0.125', '0.25') as unknown as Record<string, unknown>,
  },
  {
    name: 'GST 12% (legacy)',
    rate: '12.00',
    type: 'both',
    taxCategoryCode: 'reduced',
    isActive: false,
    jurisdictionMetadata: { ...gstSlabMeta('12', '6.00', '12.00'), legacy: true } as unknown as Record<string, unknown>,
  },
  {
    name: 'GST 28% (legacy)',
    rate: '28.00',
    type: 'both',
    taxCategoryCode: 'standard',
    isActive: false,
    jurisdictionMetadata: { ...gstSlabMeta('28', '14.00', '28.00'), legacy: true } as unknown as Record<string, unknown>,
  },
  {
    name: 'GST 0%',
    rate: '0.00',
    type: 'both',
    taxCategoryCode: 'zero',
    jurisdictionMetadata: { gstSlab: '0' },
  },
  {
    name: 'GST Exempt',
    rate: '0.00',
    type: 'both',
    taxCategoryCode: 'exempt',
    jurisdictionMetadata: { gstSlab: 'exempt' },
  },
  {
    name: 'GST Reverse Charge',
    rate: '0.00',
    type: 'purchase',
    taxCategoryCode: 'reverse_charge',
    jurisdictionMetadata: { gstSlab: 'rcm', reverseCharge: true },
  },
  {
    name: 'GST Export (0%)',
    rate: '0.00',
    type: 'sales',
    taxCategoryCode: 'export_goods',
    jurisdictionMetadata: { gstSlab: 'export' },
  },
];
