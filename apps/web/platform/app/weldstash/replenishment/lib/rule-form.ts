/**
 * The reorder rule editor's form: the text the inputs hold, and the request
 * the API takes. Pure, so the rules (min/max needs both and min <= max, ranges
 * as the API states them) are tested apart from the form.
 *
 * Empty optional inputs mean "use the workspace default": they are sent as
 * null, which clears an earlier override.
 */

import { z } from 'zod';
import { upsertReorderRuleSchema, type ReorderRule, type UpsertReorderRuleInput } from '@weldsuite/app-api-client/schemas/replenishment';

export interface RuleFormValues {
  method: 'auto' | 'min_max' | 'off';
  minQty: string;
  maxQty: string;
  /** A percentage: 95 for a service level of 0.95. */
  serviceLevelPct: string;
  reviewPeriodDays: string;
  leadTimeDaysOverride: string;
  /** Empty: the preferred product supplier. */
  productSupplierId: string;
}

export type RuleFormField = keyof RuleFormValues;
export type RuleFormErrorCode = 'invalid' | 'minmax';

export const EMPTY_RULE_FORM: RuleFormValues = {
  method: 'auto',
  minQty: '',
  maxQty: '',
  serviceLevelPct: '',
  reviewPeriodDays: '',
  leadTimeDaysOverride: '',
  productSupplierId: '',
};

const text = (value: number | string | null | undefined) => (value === null || value === undefined ? '' : String(value));

/** The form for an item's rule, or the defaults when it has none. */
export function ruleToForm(rule: ReorderRule | null): RuleFormValues {
  if (!rule) return EMPTY_RULE_FORM;
  return {
    method: rule.method,
    minQty: text(rule.minQty),
    maxQty: text(rule.maxQty),
    serviceLevelPct: rule.serviceLevel === null ? '' : text(Math.round(Number(rule.serviceLevel) * 1000) / 10),
    reviewPeriodDays: text(rule.reviewPeriodDays),
    leadTimeDaysOverride: text(rule.leadTimeDaysOverride),
    productSupplierId: text(rule.productSupplierId),
  };
}

export interface RuleItem {
  productId: string;
  variantId: string | null;
  warehouseId: string;
}

export type RuleFormResult =
  | { ok: true; input: UpsertReorderRuleInput }
  | { ok: false; errors: Partial<Record<RuleFormField, RuleFormErrorCode>> };

type ParsedInput = number | null | 'invalid';
type RuleFormErrors = Partial<Record<RuleFormField, RuleFormErrorCode>>;

function parseOptional(value: string): ParsedInput {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : 'invalid';
}

/** Not a whole number, or not a number at all; empty is fine. */
const notWhole = (value: ParsedInput) => value === 'invalid' || (value !== null && !Number.isInteger(value));

/** A min/max pair a min/max rule can use: both set, min not negative, max not below min. */
const isRange = (lo: ParsedInput, hi: ParsedInput) => typeof lo === 'number' && typeof hi === 'number' && lo >= 0 && hi >= lo;

/** What is wrong with the inputs themselves, before the API's ranges. */
function inputErrors(
  method: RuleFormValues['method'],
  parsed: Record<'minQty' | 'maxQty' | 'percent' | 'review' | 'lead', ParsedInput>,
): RuleFormErrors {
  const errors: RuleFormErrors = {};
  if (notWhole(parsed.minQty)) errors.minQty = 'invalid';
  if (notWhole(parsed.maxQty)) errors.maxQty = 'invalid';
  if (parsed.percent === 'invalid') errors.serviceLevelPct = 'invalid';
  if (notWhole(parsed.review)) errors.reviewPeriodDays = 'invalid';
  if (notWhole(parsed.lead)) errors.leadTimeDaysOverride = 'invalid';
  if (method === 'min_max' && !errors.minQty && !errors.maxQty && !isRange(parsed.minQty, parsed.maxQty)) {
    errors.maxQty = 'minmax';
  }
  return errors;
}

/** The fields an API range error maps back to, beyond the service level. */
const RANGE_FIELDS: ReadonlySet<PropertyKey> = new Set<RuleFormField>(['reviewPeriodDays', 'leadTimeDaysOverride', 'minQty', 'maxQty']);

/** A range the API refuses (a service level outside 50-99.9%, a review period over 90 days, ...) as form errors. */
function rangeErrors(issues: readonly z.ZodIssue[]): RuleFormErrors {
  const out: RuleFormErrors = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (field === 'serviceLevel') out.serviceLevelPct = 'invalid';
    else if (RANGE_FIELDS.has(field)) out[field as RuleFormField] = 'invalid';
  }
  return Object.keys(out).length > 0 ? out : { maxQty: 'invalid' };
}

/** The API request for the form, or what is wrong with it. */
export function formToRuleInput(values: RuleFormValues, item: RuleItem): RuleFormResult {
  const minQty = parseOptional(values.minQty);
  const maxQty = parseOptional(values.maxQty);
  const percent = parseOptional(values.serviceLevelPct);
  const review = parseOptional(values.reviewPeriodDays);
  const lead = parseOptional(values.leadTimeDaysOverride);

  const errors = inputErrors(values.method, { minQty, maxQty, percent, review, lead });
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const candidate = {
    productId: item.productId,
    variantId: item.variantId,
    warehouseId: item.warehouseId,
    method: values.method,
    // Min and max only mean something to a min/max rule.
    minQty: values.method === 'min_max' ? (minQty as number | null) : null,
    maxQty: values.method === 'min_max' ? (maxQty as number | null) : null,
    serviceLevel: typeof percent === 'number' ? percent / 100 : null,
    reviewPeriodDays: review as number | null,
    leadTimeDaysOverride: lead as number | null,
    productSupplierId: values.productSupplierId || null,
  };
  const parsed = upsertReorderRuleSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, errors: rangeErrors(parsed.error.issues) };
}

/** The zod schema the form validates with (react-hook-form's resolver), with the field messages in the user's language. */
export function makeRuleFormSchema(messages: Readonly<Record<RuleFormErrorCode, string>>) {
  return z
    .object({
      method: z.enum(['auto', 'min_max', 'off']),
      minQty: z.string(),
      maxQty: z.string(),
      serviceLevelPct: z.string(),
      reviewPeriodDays: z.string(),
      leadTimeDaysOverride: z.string(),
      productSupplierId: z.string(),
    })
    .superRefine((values, ctx) => {
      const result = formToRuleInput(values, { productId: 'x', variantId: null, warehouseId: 'x' });
      if (result.ok) return;
      for (const [field, code] of Object.entries(result.errors) as Array<[RuleFormField, RuleFormErrorCode]>) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: messages[code] });
      }
    });
}
