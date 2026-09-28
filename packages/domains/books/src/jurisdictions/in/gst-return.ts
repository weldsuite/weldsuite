import type { Entity } from '@weldsuite/db/schema';
import type { TaxReturnArtifact, TaxReturnLine } from '../types';

/**
 * Phase 1 stub GST return: JSON summary of taxable + CGST/SGST/IGST totals.
 * Not portal-ready (no GSTR-1/3B JSON schema); satisfies JurisdictionAdapter.buildTaxReturn.
 */
export async function buildInGstReturn(
  entity: Entity,
  periodStart: string,
  periodEnd: string,
  lines: TaxReturnLine[],
): Promise<TaxReturnArtifact> {
  const summary = {
    taxableAmount: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    cess: 0,
    totalTax: 0,
  };

  for (const line of lines) {
    summary.taxableAmount += line.taxableAmount;
    summary.totalTax += line.taxAmount;
    const component = line.jurisdictionMetadata?.gstComponent as string | undefined;
    if (component === 'cgst') summary.cgst += line.taxAmount;
    else if (component === 'sgst') summary.sgst += line.taxAmount;
    else if (component === 'igst') summary.igst += line.taxAmount;
    else if (component === 'cess') summary.cess += line.taxAmount;
  }

  const payload = {
    version: 'phase1-summary',
    gstin: entity.taxIdentifiers?.vatNumber ?? '',
    companyName: entity.legalName ?? entity.name,
    periodStart,
    periodEnd,
    lines: lines.map((l) => ({
      taxRateId: l.taxRateId,
      taxCategoryCode: l.taxCategoryCode,
      taxableAmount: l.taxableAmount,
      taxAmount: l.taxAmount,
      gstComponent: l.jurisdictionMetadata?.gstComponent ?? null,
      gstSlab: l.jurisdictionMetadata?.gstSlab ?? null,
    })),
    summary,
  };

  return {
    filename: `gst-summary-${periodStart}-${periodEnd}.json`,
    mimeType: 'application/json',
    content: JSON.stringify(payload, null, 2),
    summary,
  };
}
