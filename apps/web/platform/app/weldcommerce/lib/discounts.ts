/**
 * Discount codes in the UI: status badges, how a value reads, and the form's
 * values and validation, with the conversion to the API's body.
 */

import { z } from 'zod';
import type { SoftTone } from '@weldsuite/ui/components/soft-badge';
import type {
  CommerceDiscount,
  DiscountAppliesTo,
  DiscountInput,
  DiscountStatus,
  DiscountType,
} from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { MONEY_PATTERN } from './order-form';
import { money } from './orders';

export const DISCOUNT_TYPES: readonly DiscountType[] = ['percentage', 'fixed_amount', 'free_shipping'];
export const DISCOUNT_STATUSES: readonly DiscountStatus[] = ['draft', 'active', 'archived'];
export const DISCOUNT_EFFECTIVE_STATUSES = ['active', 'scheduled', 'draft', 'expired', 'used_up', 'archived'] as const;
export const DISCOUNT_APPLIES_TO: readonly DiscountAppliesTo[] = ['all', 'products', 'categories'];

const EFFECTIVE_TONES: Record<string, SoftTone> = {
  active: 'success',
  scheduled: 'warning',
  draft: 'neutral',
  expired: 'danger',
  used_up: 'danger',
  archived: 'neutral',
};

export function discountStatusTone(effectiveStatus: string): SoftTone {
  return EFFECTIVE_TONES[effectiveStatus] ?? 'neutral';
}

/** An effective status in the UI language; one this version doesn't know, as stored. */
export function discountStatusLabel(effectiveStatus: string): string {
  const labels: Record<string, string> = getTranslations('commerce').discounts.effectiveStatus;
  return labels[effectiveStatus] ?? effectiveStatus.replace(/_/g, ' ');
}

/** "10%", "€5.00 off" or "Free shipping". */
export function formatDiscountValue(discount: Pick<CommerceDiscount, 'type' | 'value' | 'currency'>): string {
  const t = getTranslations('commerce').discounts;
  if (discount.type === 'free_shipping') return t.type.free_shipping;
  if (discount.type === 'percentage') return `${Number(discount.value)}%`;
  return money(discount.value, discount.currency);
}

/** How often a code was used: "3" or "3 of 50". */
export function formatUsage(discount: Pick<CommerceDiscount, 'usageCount' | 'usageLimit'>): string {
  const t = getTranslations('commerce').discounts;
  if (discount.usageLimit === null) return String(discount.usageCount);
  return t.usageOf.replace('{count}', String(discount.usageCount)).replace('{limit}', String(discount.usageLimit));
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export interface DiscountFormValues {
  name: string;
  description: string;
  code: string;
  type: DiscountType;
  value: string;
  currency: string;
  maxDiscountAmount: string;
  appliesTo: DiscountAppliesTo;
  productIds: string[];
  categoryIds: string[];
  minimumSubtotal: string;
  minimumQuantity?: number;
  usageLimit?: number;
  usageLimitPerCustomer?: number;
  status: DiscountStatus;
  /** `datetime-local` text, in the member's time zone. */
  startsAt: string;
  endsAt: string;
}

export function emptyDiscountValues(currency: string): DiscountFormValues {
  return {
    name: '',
    description: '',
    code: '',
    type: 'percentage',
    value: '',
    currency,
    maxDiscountAmount: '',
    appliesTo: 'all',
    productIds: [],
    categoryIds: [],
    minimumSubtotal: '',
    minimumQuantity: undefined,
    usageLimit: undefined,
    usageLimitPerCustomer: undefined,
    status: 'active',
    startsAt: '',
    endsAt: '',
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** An ISO timestamp as the text of a `datetime-local` input (local time); blank when there is none. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The text of a `datetime-local` input as an ISO timestamp, or null when blank or invalid. */
export function localInputToIso(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function valuesFromDiscount(discount: CommerceDiscount): DiscountFormValues {
  return {
    name: discount.name,
    description: discount.description ?? '',
    code: discount.code,
    type: discount.type,
    value: discount.type === 'free_shipping' ? '' : String(Number(discount.value)),
    currency: discount.currency ?? '',
    maxDiscountAmount: discount.maxDiscountAmount ?? '',
    appliesTo: discount.appliesTo,
    productIds: discount.productIds,
    categoryIds: discount.categoryIds,
    minimumSubtotal: discount.minimumSubtotal ?? '',
    minimumQuantity: discount.minimumQuantity ?? undefined,
    usageLimit: discount.usageLimit ?? undefined,
    usageLimitPerCustomer: discount.usageLimitPerCustomer ?? undefined,
    status: discount.status,
    startsAt: isoToLocalInput(discount.startsAt),
    endsAt: isoToLocalInput(discount.endsAt),
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A count field's value for the API: blank (undefined or NaN) is no limit. */
function countOrNull(value: number | undefined): number | null {
  return value === undefined || Number.isNaN(value) ? null : value;
}

/**
 * The body of a create or an update. What a type doesn't use is cleared
 * (a percentage has no currency, a code for everything has no product list),
 * so changing the type never leaves a stale value behind. The variants a
 * discount names are not edited here and are left alone, except that
 * narrowing the code to something other than products clears them.
 */
export function toDiscountInput(values: DiscountFormValues): DiscountInput {
  const body: DiscountInput = {
    name: values.name.trim(),
    description: blankToNull(values.description),
    code: values.code.trim(),
    type: values.type,
    value: values.type === 'free_shipping' ? '0' : values.value.trim(),
    currency: values.type === 'fixed_amount' ? values.currency.trim().toUpperCase() : null,
    maxDiscountAmount: values.type === 'percentage' ? blankToNull(values.maxDiscountAmount) : null,
    appliesTo: values.appliesTo,
    productIds: values.appliesTo === 'products' ? values.productIds : [],
    categoryIds: values.appliesTo === 'categories' ? values.categoryIds : [],
    minimumSubtotal: blankToNull(values.minimumSubtotal),
    minimumQuantity: countOrNull(values.minimumQuantity),
    usageLimit: countOrNull(values.usageLimit),
    usageLimitPerCustomer: countOrNull(values.usageLimitPerCustomer),
    status: values.status,
    startsAt: localInputToIso(values.startsAt),
    endsAt: localInputToIso(values.endsAt),
  };
  if (values.appliesTo !== 'products') body.variantIds = [];
  return body;
}

/** A whole number of 1 or more; blank is NaN (see the count fields) or nothing. */
const optionalCount = z.union([z.number().int().min(1).max(1_000_000_000), z.nan()]).optional();

/** The discount form's schema, with its own messages in the UI language. */
export function buildDiscountFormSchema() {
  const t = getTranslations('commerce').discounts.form;
  return z
    .object({
      name: z.string().trim().min(1).max(255),
      description: z.string().max(2000),
      code: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^\S+$/, t.codeNoSpaces),
      type: z.enum(['percentage', 'fixed_amount', 'free_shipping']),
      value: z.string(),
      currency: z.string(),
      maxDiscountAmount: z.string(),
      appliesTo: z.enum(['all', 'products', 'categories']),
      productIds: z.array(z.string()),
      categoryIds: z.array(z.string()),
      minimumSubtotal: z.string(),
      minimumQuantity: optionalCount,
      usageLimit: optionalCount,
      usageLimitPerCustomer: optionalCount,
      status: z.enum(['draft', 'active', 'archived']),
      startsAt: z.string(),
      endsAt: z.string(),
    })
    .superRefine((values, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      checkDiscountValue(values, issue, t);
      if (values.maxDiscountAmount.trim() !== '' && !MONEY_PATTERN.test(values.maxDiscountAmount.trim())) {
        issue('maxDiscountAmount', t.invalidAmount);
      }
      if (values.minimumSubtotal.trim() !== '' && !MONEY_PATTERN.test(values.minimumSubtotal.trim())) {
        issue('minimumSubtotal', t.invalidAmount);
      }
      if (values.appliesTo === 'products' && values.productIds.length === 0) issue('productIds', t.productsRequired);
      if (values.appliesTo === 'categories' && values.categoryIds.length === 0) issue('categoryIds', t.categoriesRequired);
      const starts = localInputToIso(values.startsAt);
      const ends = localInputToIso(values.endsAt);
      if (starts && ends && ends <= starts) issue('endsAt', t.endsBeforeStart);
    });
}

type FormMessages = ReturnType<typeof getTranslations<'commerce'>>['discounts']['form'];

function checkDiscountValue(
  values: Pick<DiscountFormValues, 'type' | 'value' | 'currency'>,
  issue: (path: string, message: string) => void,
  t: FormMessages,
): void {
  if (values.type === 'free_shipping') return;
  const value = values.value.trim();
  if (value === '') {
    issue('value', t.valueRequired);
  } else if (!MONEY_PATTERN.test(value) || Number(value) <= 0) {
    issue('value', t.invalidAmount);
  } else if (values.type === 'percentage' && Number(value) > 100) {
    issue('value', t.percentageTooHigh);
  }
  if (values.type === 'fixed_amount' && !/^[A-Za-z]{3}$/.test(values.currency.trim())) {
    issue('currency', t.invalidCurrency);
  }
}
