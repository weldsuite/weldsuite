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

function parseOptional(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : 'invalid';
}

/** The API request for the form, or what is wrong with it. */
export function formToRuleInput(values: RuleFormValues, item: RuleItem): RuleFormResult {
  const errors: Partial<Record<RuleFormField, RuleFormErrorCode>> = {};
  const minQty = parseOptional(values.minQty);
  const maxQty = parseOptional(values.maxQty);
  const percent = parseOptional(values.serviceLevelPct);
  const review = parseOptional(values.reviewPeriodDays);
  const lead = parseOptional(values.leadTimeDaysOverride);

  if (minQty === 'invalid' || (minQty !== null && !Number.isInteger(minQty))) errors.minQty = 'invalid';
  if (maxQty === 'invalid' || (maxQty !== null && !Number.isInteger(maxQty))) errors.maxQty = 'invalid';
  if (percent === 'invalid') errors.serviceLevelPct = 'invalid';
  if (review === 'invalid' || (review !== null && !Number.isInteger(review))) errors.reviewPeriodDays = 'invalid';
  if (lead === 'invalid' || (lead !== null && !Number.isInteger(lead))) errors.leadTimeDaysOverride = 'invalid';

  if (values.method === 'min_max' && !errors.minQty && !errors.maxQty) {
    const lo = minQty as number | null;
    const hi = maxQty as number | null;
    if (lo === null || hi === null || lo < 0 || hi < lo) errors.maxQty = 'minmax';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const candidate = {
    productId: item.productId,
    variantId: item.variantId,
    warehouseId: item.warehouseId,
    method: values.method,
    // Min and max only mean something to a min/max rule.
    minQty: values.method === 'min_max' ? (minQty as number | null) : null,
    maxQty: values.method === 'min_max' ? (maxQty as number | null) : null,
    serviceLevel: percent === null || percent === 'invalid' ? null : percent / 100,
    reviewPeriodDays: review as number | null,
    leadTimeDaysOverride: lead as number | null,
    productSupplierId: values.productSupplierId || null,
  };
  const parsed = upsertReorderRuleSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };

  // A range the API refuses (a service level outside 50-99.9%, a review period over 90 days, ...).
  const out: Partial<Record<RuleFormField, RuleFormErrorCode>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'serviceLevel') out.serviceLevelPct = 'invalid';
    else if (field === 'reviewPeriodDays' || field === 'leadTimeDaysOverride' || field === 'minQty' || field === 'maxQty') out[field] = 'invalid';
  }
  return { ok: false, errors: Object.keys(out).length > 0 ? out : { maxQty: 'invalid' } };
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
