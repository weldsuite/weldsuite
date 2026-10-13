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
import { GST_FOREIGN_COUNTRY_CODE, isValidGstStateCode, usesUtgst } from './states';

export * from './states';
export { computeGstWorksheet, utiliseItc } from './gst-return';
export type * from './gst-return';

/** GSTIN: 2-digit state + PAN(10) + entity + Z + check digit. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

export function normalizeGstin(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

export function extractStateCodeFromGstin(gstin: string): string | undefined {
  const normalized = normalizeGstin(gstin);
  const match = /^\d{2}/.exec(normalized);
  return match?.[0];
}

export function extractPanFromGstin(gstin: string): string | undefined {
  const normalized = normalizeGstin(gstin);
  if (!GSTIN_RE.test(normalized)) return undefined;
  return normalized.slice(2, 12);
}

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The check character of a GSTIN: base-36 weighted sum over the first 14
 * characters (weights 1, 2, 1, 2, ...; each product's base-36 digits are
 * added), complemented to a multiple of 36.
 */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_ALPHABET.indexOf(first14[i] ?? '');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

/**
 * Validate a GSTIN: format, a real state code (01-38 and 97; 00 and 99 are
 * rejected), the check character and, when `pan` is given, that the PAN
 * inside the GSTIN (characters 3-12) is the entity's own.
 */
export function validateGstin(value: string, opts: { pan?: string | null } = {}): TaxIdentifierValidation {
  const normalized = normalizeGstin(value);
  if (!GSTIN_RE.test(normalized)) {
    return {
      valid: false,
      error: 'GSTIN must be 15 characters (e.g. 27AAPFU0939F1ZV)',
    };
  }
  if (!isValidGstStateCode(normalized.slice(0, 2))) {
    return {
      valid: false,
      error: `GSTIN has an invalid state code '${normalized.slice(0, 2)}' (valid codes are 01-38 and 97)`,
    };
  }
  if (gstinCheckCharacter(normalized.slice(0, 14)) !== normalized[14]) {
    return { valid: false, error: 'GSTIN check digit is wrong: check the number for a typo' };
  }
  const pan = opts.pan ? opts.pan.replace(/\s/g, '').toUpperCase() : '';
  if (pan && PAN_RE.test(pan) && normalized.slice(2, 12) !== pan) {
    return {
      valid: false,
      error: `GSTIN contains PAN ${normalized.slice(2, 12)}, which does not match the PAN ${pan}`,
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
  if ((buyer && buyer !== 'IN') || buyerStateCode === GST_FOREIGN_COUNTRY_CODE) {
    return null; // caller handles export
  }

  const seller = sellerStateCode?.padStart(2, '0');
  const buyerState = buyerStateCode?.padStart(2, '0');
  const intrastate = Boolean(seller && buyerState && seller === buyerState);
  const list = (intrastate ? meta.components.intrastate : meta.components.interstate).map((c) =>
    intrastate && c.code === 'sgst' && usesUtgst(seller) ? { ...c, code: 'utgst' as const } : c,
  );
  const intrastateTaxes = usesUtgst(seller) ? 'CGST + UTGST' : 'CGST + SGST';

  return {
    taxCategoryCode: 'standard',
    rate: meta.gstSlab.includes('.') ? meta.gstSlab : `${meta.gstSlab}.00`,
    reasoning: intrastate
      ? `Intra-state supply (${seller}→${buyerState}) — ${intrastateTaxes}`
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
  features: {
    vatReturn: false,
    icp: false,
    xafExport: false,
    smallBusinessScheme: false,
    gstReturn: true,
    salesTax: false,
    form1099: false,
  },
  terminology: {
    tax: 'gst',
    taxId: 'gstin',
    registrationId: 'pan',
    supplier: 'supplier',
    creditNote: 'credit_note',
  },
  purchaseTax: 'recoverable',

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
    if ((buyerCountry && buyerCountry !== 'IN') || ctx.buyerStateCode === GST_FOREIGN_COUNTRY_CODE) {
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
        reasoning: `Unsupported GST slab '${ctx.gstSlab}' — choose a seeded rate (0.25/3/5/18/40, or legacy 12/28)`,
      };
    }
    const resolved = category ?? findSlabCategory('18');
    const meta = parseSlabMetadata(resolved?.jurisdictionMetadata);

    if (!meta || slab === '0' || slab === 'exempt' || slab === 'export' || slab === 'rcm') {
      const code = resolved?.taxCategoryCode ?? 'zero';
      let reasoning = 'GST zero-rated supply';
      if (code === 'exempt') reasoning = 'GST exempt supply';
      else if (code === 'reverse_charge') reasoning = 'GST reverse charge — tax not charged on invoice';
      return {
        taxCategoryCode: code,
        rate: resolved?.rate ?? '0.00',
        reasoning,
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
  if (!/^\d{2}$/.test(trimmed)) return undefined;
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
  if ((buyerCountry && buyerCountry !== 'IN') || opts.buyerStateCode === GST_FOREIGN_COUNTRY_CODE) {
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
  // A union territory without a legislature levies UTGST where a state levies SGST.
  const utgst = intrastate && usesUtgst(seller);

  return list.map((c) => {
    const rate = Number.parseFloat(c.rate);
    const taxAmount = opts.taxableAmount * (rate / 100);
    const code = utgst && c.code === 'sgst' ? ('utgst' as const) : c.code;
    let labelPrefix = 'IGST';
    if (code === 'cgst') labelPrefix = 'CGST';
    else if (code === 'sgst') labelPrefix = 'SGST';
    else if (code === 'utgst') labelPrefix = 'UTGST';
    const label = `${labelPrefix} ${rate}%`;
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
      // UTGST posts to the SGST ledger accounts until dedicated UTGST roles exist.
      component: code,
      accountRole,
    };
  });
}
