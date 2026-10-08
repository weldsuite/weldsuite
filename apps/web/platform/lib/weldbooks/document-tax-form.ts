/**
 * The tax fields of a document line as the forms hold them (strings and
 * booleans a controlled input can bind to), the Zod fragment that validates
 * them, and what they become in a create / update body.
 *
 * Shared by the invoice form and dialog, the bill form, the recurring invoice
 * form and the journal entry form, so every document writes the same fields.
 */
import { z } from 'zod';
import { amountString, hasCompleteOverride, type TaxFormLine, type TaxUseChoice } from './document-tax';

/** Sales tax and dimension values of a line, as form state. Empty string = not set. */
export interface SalesTaxLineValues {
  /** Catalogue product (US sales tax lines): its tax class gave the code. */
  productId: string;
  /** `''` = the default: the product's code, else general goods. */
  taxCode: string;
  /** `''` = the customer's default use. */
  taxUse: TaxUseChoice;
  taxIncluded: boolean;
  /** The "override the tax" controls are open. */
  taxOverrideEnabled: boolean;
  taxOverrideAmount: string;
  taxOverrideReason: string;
  classId: string;
  locationId: string;
  /** Credit memo lines: the invoice line credited. */
  originalLineId: string;
}

export const EMPTY_SALES_TAX_LINE: SalesTaxLineValues = {
  productId: '',
  taxCode: '',
  taxUse: '',
  taxIncluded: false,
  taxOverrideEnabled: false,
  taxOverrideAmount: '',
  taxOverrideReason: '',
  classId: '',
  locationId: '',
  originalLineId: '',
};

/** The Zod fields of {@link SalesTaxLineValues}; spread into a line schema, then `.superRefine(overrideChecks(...))`. */
export const salesTaxLineFields = {
  productId: z.string().default(''),
  taxCode: z.string().default(''),
  taxUse: z.enum(['', 'business', 'personal']).default(''),
  taxIncluded: z.boolean().default(false),
  taxOverrideEnabled: z.boolean().default(false),
  taxOverrideAmount: z.string().default(''),
  taxOverrideReason: z.string().default(''),
  classId: z.string().default(''),
  locationId: z.string().default(''),
  originalLineId: z.string().default(''),
};

export interface OverrideMessages {
  /** A tax override needs a reason. */
  reasonRequired: string;
  /** The override amount is not a number of zero or more. */
  amountInvalid: string;
}

/**
 * Refinement of a line schema: an override with an amount needs a reason, and
 * the amount must be zero or more. The reason is what makes an override
 * auditable, so it can't be left out.
 */
export function overrideChecks(messages: OverrideMessages) {
  return (
    line: Pick<SalesTaxLineValues, 'taxOverrideEnabled' | 'taxOverrideAmount' | 'taxOverrideReason'>,
    ctx: z.RefinementCtx,
  ) => {
    if (!line.taxOverrideEnabled) return;
    const amount = line.taxOverrideAmount.trim();
    if (amount === '') return;
    if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxOverrideAmount'], message: messages.amountInvalid });
    }
    if (line.taxOverrideReason.trim() === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxOverrideReason'], message: messages.reasonRequired });
    }
  };
}

/** The line's tax values for the preview request (see `buildTaxPreviewRequest`). */
export function toTaxFormLine(
  line: Partial<SalesTaxLineValues> & {
    description?: string | null;
    quantity?: number | string | null;
    unitPrice?: number | string | null;
    discountPercent?: number | string | null;
    taxRateId?: string | null;
  },
): TaxFormLine {
  return {
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountPercent: line.discountPercent,
    taxRateId: line.taxRateId,
    productId: line.productId || null,
    taxCode: line.taxCode || null,
    taxUse: line.taxUse || null,
    taxIncluded: line.taxIncluded ?? false,
    taxOverrideAmount: line.taxOverrideEnabled ? line.taxOverrideAmount : null,
    taxOverrideReason: line.taxOverrideEnabled ? line.taxOverrideReason : null,
    originalLineId: line.originalLineId || null,
  };
}

/**
 * The US sales tax fields of an invoice, credit memo or template line body.
 * An override is sent only when it is complete (amount and reason); turning
 * it off sends nulls, which clears a stored one.
 */
export function salesTaxLinePayload(line: Partial<SalesTaxLineValues>): {
  productId: string | null;
  taxCode: string | null;
  taxUse: 'business' | 'personal' | null;
  taxIncluded: boolean;
  taxOverrideAmount: string | null;
  taxOverrideReason: string | null;
} {
  const override =
    line.taxOverrideEnabled &&
    hasCompleteOverride({ taxOverrideAmount: line.taxOverrideAmount, taxOverrideReason: line.taxOverrideReason });
  return {
    productId: line.productId || null,
    taxCode: line.taxCode || null,
    taxUse: line.taxUse || null,
    taxIncluded: line.taxIncluded ?? false,
    taxOverrideAmount: override ? String(Number(line.taxOverrideAmount)) : null,
    taxOverrideReason: override ? (line.taxOverrideReason?.trim() ?? null) : null,
  };
}

/** The reporting dimensions of a line body; empty values clear a stored one. */
export function dimensionPayload(line: Partial<Pick<SalesTaxLineValues, 'classId' | 'locationId'>>): {
  classId: string | null;
  locationId: string | null;
} {
  return { classId: line.classId || null, locationId: line.locationId || null };
}

export { amountString };

/** An amount field as the API takes it (a string); `undefined` for an empty or zero value. */
export function amountOrUndefined(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? String(n) : undefined;
}

