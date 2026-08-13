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
  const match = normalized.match(/^[0-9]{2}/);
  return match?.[0];
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
  if (
    !components ||
    !Array.isArray(components.intrastate) ||
    !Array.isArray(components.interstate) ||
    components.intrastate.length === 0 ||
    components.interstate.length === 0
  ) {
    return null;
  }
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

    const sellerState = normalizeStateCode(ctx.sellerStateCode);
    const buyerState = normalizeStateCode(
      ctx.buyerStateCode ??
        (ctx.buyerGstin ? extractStateCodeFromGstin(ctx.buyerGstin) : undefined),
    );

    const slab = (ctx.gstSlab ?? '18').replace(/\.00$/, '');
    const category = findSlabCategory(slab);
    if (!category && ctx.gstSlab) {
      return {
        taxCategoryCode: 'standard',
        rate: '0.00',
        reasoning: `Unsupported GST slab '${ctx.gstSlab}' — choose a seeded rate (5/12/18/28/40)`,
      };
    }
    const resolved = category ?? findSlabCategory('18');
    const meta = parseSlabMetadata(resolved?.jurisdictionMetadata);

    if (!meta || slab === '0' || slab === 'exempt' || slab === 'export' || slab === 'rcm') {
      const code = resolved?.taxCategoryCode ?? 'zero';
      return {
        taxCategoryCode: code,
        rate: resolved?.rate ?? '0.00',
        reasoning:
          code === 'exempt'
            ? 'GST exempt supply'
            : code === 'reverse_charge'
              ? 'GST reverse charge — tax not charged on invoice'
              : 'GST zero-rated supply',
      };
    }

    // Fail closed: no component split until both state codes are known
    if (!sellerState || !buyerState) {
      return {
        taxCategoryCode: resolved?.taxCategoryCode ?? 'standard',
        rate: resolved?.rate ?? `${meta.gstSlab}.00`,
        reasoning:
          'GST slab applied without CGST/SGST/IGST split — place of supply unknown (set seller and buyer state)',
      };
    }

    const place = componentsForPlaceOfSupply(meta, sellerState, buyerState, buyerCountry ?? 'IN');
    if (!place) {
      return {
        taxCategoryCode: 'export_goods',
        rate: '0.00',
        reasoning: 'Export outside India — zero-rated GST',
      };
    }

    return {
      taxCategoryCode: resolved?.taxCategoryCode ?? place.taxCategoryCode,
      rate: resolved?.rate ?? place.rate,
      reasoning: place.reasoning,
      components: place.components,
    };
  },
};

function normalizeStateCode(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^[0-9]{2}$/.test(trimmed)) return undefined;
  return trimmed;
}

const OUTPUT_TO_INPUT_ROLE: Record<string, string> = {
  tax_output_cgst: 'tax_input_cgst',
  tax_output_sgst: 'tax_input_sgst',
  tax_output_igst: 'tax_input_igst',
};

/**
 * Expand a seeded GST slab rate's metadata into tax-breakdown rows
 * for a given taxable amount and place of supply.
 * Fails closed (single slab row, no components) when seller/buyer state is unknown.
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
  /** sales → tax_output_*; purchase → tax_input_* */
  direction?: 'sales' | 'purchase';
}): Array<{
  taxRateId: string;
  taxRateName: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  component?: string;
  accountRole?: string;
}> {
  const singleSlab = () => {
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
  };

  const meta = parseSlabMetadata(opts.jurisdictionMetadata ?? undefined);
  if (!meta) return singleSlab();

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

  const seller = normalizeStateCode(opts.sellerStateCode);
  const buyer = normalizeStateCode(opts.buyerStateCode);
  if (!seller || !buyer) {
    // Fail closed — do not assume IGST
    return singleSlab();
  }

  const intrastate = seller === buyer;
  const list = intrastate ? meta.components.intrastate : meta.components.interstate;
  const direction = opts.direction ?? 'sales';

  return list.map((c) => {
    const rate = parseFloat(c.rate);
    const taxAmount = opts.taxableAmount * (rate / 100);
    const label =
      c.code === 'cgst'
        ? `CGST ${rate}%`
        : c.code === 'sgst'
          ? `SGST ${rate}%`
          : `IGST ${rate}%`;
    const outputRole = c.accountRole;
    const accountRole =
      direction === 'purchase'
        ? (OUTPUT_TO_INPUT_ROLE[outputRole] ?? outputRole)
        : outputRole;
    return {
      taxRateId: opts.taxRateId,
      taxRateName: label,
      taxRate: rate,
      taxableAmount: opts.taxableAmount,
      taxAmount,
      component: c.code,
      accountRole,
    };
  });
}
