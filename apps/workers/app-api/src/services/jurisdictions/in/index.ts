import type {
  GstSlabMetadata,
  JurisdictionAdapter,
  TaxIdentifierType,
  TaxIdentifierValidation,
  TaxRateComponentDecision,
  TaxRateDecision,
  TaxResolutionContext,
} from '../types';
import { inChartOfAccounts } from './chart-of-accounts';
import { inTaxCategories } from './tax-categories';
import { getInInvoiceRequirements } from './invoice-format';
import { buildInGstReturn } from './gst-return';

/** GSTIN: 2-digit state + PAN(10) + entity + Z + check digit. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

export function normalizeGstin(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

export function extractStateCodeFromGstin(gstin: string): string | undefined {
  const normalized = normalizeGstin(gstin);
  if (normalized.length < 2) return undefined;
  return normalized.slice(0, 2);
}

export function extractPanFromGstin(gstin: string): string | undefined {
  const normalized = normalizeGstin(gstin);
  if (!GSTIN_RE.test(normalized)) return undefined;
  return normalized.slice(2, 12);
}

export function validateGstin(value: string): TaxIdentifierValidation {
  const normalized = normalizeGstin(value);
  if (!GSTIN_RE.test(normalized)) {
    return {
      valid: false,
      error: 'GSTIN must be 15 characters (e.g. 27AABCU9603R1ZM)',
    };
  }
  return { valid: true, formatted: normalized };
}

export function validatePan(value: string): TaxIdentifierValidation {
  const normalized = value.replace(/\s/g, '').toUpperCase();
  if (!PAN_RE.test(normalized)) {
    return { valid: false, error: 'PAN must match format AAAAA9999A' };
  }
  return { valid: true, formatted: normalized };
}

function parseSlabMetadata(
  meta: Record<string, unknown> | undefined,
): GstSlabMetadata | null {
  if (!meta || typeof meta.gstSlab !== 'string') return null;
  const components = meta.components as GstSlabMetadata['components'] | undefined;
  if (!components?.intrastate || !components?.interstate) return null;
  return meta as unknown as GstSlabMetadata;
}

function componentsForPlaceOfSupply(
  meta: GstSlabMetadata,
  sellerStateCode?: string,
  buyerStateCode?: string,
  buyerCountry?: string,
): { components: TaxRateComponentDecision[]; reasoning: string; taxCategoryCode: string; rate: string } | null {
  const buyer = buyerCountry?.toUpperCase();
  if (buyer && buyer !== 'IN') {
    return null; // caller handles export
  }

  const seller = sellerStateCode?.padStart(2, '0');
  const buyerState = buyerStateCode?.padStart(2, '0');
  const intrastate = Boolean(seller && buyerState && seller === buyerState);
  const list = intrastate ? meta.components.intrastate : meta.components.interstate;

  return {
    taxCategoryCode: 'standard',
    rate: meta.gstSlab.includes('.') ? meta.gstSlab : `${meta.gstSlab}.00`,
    reasoning: intrastate
      ? `Intra-state supply (${seller}→${buyerState}) — CGST + SGST`
      : `Inter-state supply (${seller ?? '?'}→${buyerState ?? '?'}) — IGST`,
    components: list.map((c) => ({
      taxCategoryCode: 'standard',
      rate: c.rate,
      component: c.code,
      accountRole: c.accountRole,
      jurisdictionMetadata: { gstComponent: c.code, gstSlab: meta.gstSlab },
    })),
  };
}

function findSlabCategory(slab: string) {
  const normalized = slab.replace(/\.00$/, '');
  return inTaxCategories.find((t) => {
    const meta = t.jurisdictionMetadata as { gstSlab?: string } | undefined;
    return meta?.gstSlab === normalized || t.rate === `${normalized}.00` || t.rate === normalized;
  });
}

export const inAdapter: JurisdictionAdapter = {
  code: 'IN',
  name: 'India',
  defaultLocale: 'en-IN',
  defaultCurrency: 'INR',

  getChartOfAccountsTemplate() {
    return inChartOfAccounts;
  },

  getStandardTaxCategories() {
    return inTaxCategories;
  },

  validateTaxIdentifier(type: TaxIdentifierType, value: string): TaxIdentifierValidation {
    if (type === 'vatNumber') return validateGstin(value);
    if (type === 'registrationNumber') return validatePan(value);
    return { valid: true, formatted: value };
  },

  buildTaxReturn(entity, periodStart, periodEnd, lines) {
    return buildInGstReturn(entity, periodStart, periodEnd, lines);
  },

  getInvoiceRequirements(locale) {
    return getInInvoiceRequirements(locale ?? 'en-IN');
  },

  resolveTaxRate(ctx: TaxResolutionContext): TaxRateDecision {
    const buyerCountry = ctx.buyerCountry?.toUpperCase();

    // Export / non-India buyer → 0% export
    if (buyerCountry && buyerCountry !== 'IN') {
      return {
        taxCategoryCode: 'export_goods',
        rate: '0.00',
        reasoning: 'Export outside India — zero-rated GST',
      };
    }

    const sellerState = ctx.sellerStateCode;
    const buyerState =
      ctx.buyerStateCode ??
      (ctx.buyerGstin ? extractStateCodeFromGstin(ctx.buyerGstin) : undefined);

    const slab = (ctx.gstSlab ?? '18').replace(/\.00$/, '');
    const category = findSlabCategory(slab) ?? findSlabCategory('18');
    const meta = parseSlabMetadata(category?.jurisdictionMetadata);

    if (!meta || slab === '0' || slab === 'exempt' || slab === 'export' || slab === 'rcm') {
      const code = category?.taxCategoryCode ?? 'zero';
      return {
        taxCategoryCode: code,
        rate: category?.rate ?? '0.00',
        reasoning:
          code === 'exempt'
            ? 'GST exempt supply'
            : code === 'reverse_charge'
              ? 'GST reverse charge — tax not charged on invoice'
              : 'GST zero-rated supply',
      };
    }

    // Without state info, default to IGST (safer for inter-state until states are set)
    const place = componentsForPlaceOfSupply(
      meta,
      sellerState ?? ctx.sellerStateCode,
      buyerState,
      buyerCountry ?? 'IN',
    );

    if (!place) {
      return {
        taxCategoryCode: 'export_goods',
        rate: '0.00',
        reasoning: 'Export outside India — zero-rated GST',
      };
    }

    // If neither state is known, still return interstate IGST components for the slab
    if (!ctx.sellerStateCode && !buyerState) {
      const interstate = meta.components.interstate;
      return {
        taxCategoryCode: category?.taxCategoryCode ?? 'standard',
        rate: category?.rate ?? `${meta.gstSlab}.00`,
        reasoning: 'GST slab applied (place of supply unknown — defaulting to IGST)',
        components: interstate.map((c) => ({
          taxCategoryCode: category?.taxCategoryCode ?? 'standard',
          rate: c.rate,
          component: c.code,
          accountRole: c.accountRole,
          jurisdictionMetadata: { gstComponent: c.code, gstSlab: meta.gstSlab },
        })),
      };
    }

    return {
      taxCategoryCode: category?.taxCategoryCode ?? place.taxCategoryCode,
      rate: category?.rate ?? place.rate,
      reasoning: place.reasoning,
      components: place.components,
    };
  },
};

/**
 * Expand a seeded GST slab rate's metadata into tax-breakdown rows
 * for a given taxable amount and place of supply.
 */
export function expandGstTaxBreakdown(opts: {
  taxableAmount: number;
  taxRateId: string;
  taxRateName: string;
  slabRate: number;
  jurisdictionMetadata?: Record<string, unknown> | null;
  sellerStateCode?: string;
  buyerStateCode?: string;
  buyerCountry?: string;
}): Array<{
  taxRateId: string;
  taxRateName: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  component?: string;
  accountRole?: string;
}> {
  const meta = parseSlabMetadata(opts.jurisdictionMetadata ?? undefined);
  if (!meta) {
    const taxAmount = opts.taxableAmount * (opts.slabRate / 100);
    return [
      {
        taxRateId: opts.taxRateId,
        taxRateName: opts.taxRateName,
        taxRate: opts.slabRate,
        taxableAmount: opts.taxableAmount,
        taxAmount,
      },
    ];
  }

  const buyerCountry = opts.buyerCountry?.toUpperCase();
  if (buyerCountry && buyerCountry !== 'IN') {
    return [
      {
        taxRateId: opts.taxRateId,
        taxRateName: 'GST Export (0%)',
        taxRate: 0,
        taxableAmount: opts.taxableAmount,
        taxAmount: 0,
        component: 'export',
      },
    ];
  }

  const seller = opts.sellerStateCode?.padStart(2, '0');
  const buyer = opts.buyerStateCode?.padStart(2, '0');
  const intrastate = Boolean(seller && buyer && seller === buyer);
  const list = intrastate ? meta.components.intrastate : meta.components.interstate;

  return list.map((c) => {
    const rate = parseFloat(c.rate);
    const taxAmount = opts.taxableAmount * (rate / 100);
    const label =
      c.code === 'cgst'
        ? `CGST ${rate}%`
        : c.code === 'sgst'
          ? `SGST ${rate}%`
          : `IGST ${rate}%`;
    return {
      taxRateId: opts.taxRateId,
      taxRateName: label,
      taxRate: rate,
      taxableAmount: opts.taxableAmount,
      taxAmount,
      component: c.code,
      accountRole: c.accountRole,
    };
  });
}
