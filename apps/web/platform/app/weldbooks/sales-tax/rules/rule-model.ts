/**
 * Taxability rules without the React: the WeldBooks product tax codes, the form
 * values, the validation schema and the conversions to what the API takes.
 *
 * A rule says, per agency and product tax code, whether the code is taxable,
 * from when, on what share of the price, for business or personal use only,
 * and optionally at a different combined rate. No rule means taxable at 100%.
 */
import { z } from 'zod';
import type {
  CreateRuleInput,
  RuleUse,
  SalesTaxRule,
  UpdateRuleInput,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { formatPercent } from '../setup/format';
import type { ValidationTexts } from '../setup/setup-texts';
import { parsePercent } from '../rates/rate-model';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The WeldBooks product tax codes. Mirrors `WELD_TAX_CODES` in
 * `@weldsuite/books-domain/jurisdictions/us/tax-codes` (the platform doesn't
 * import the domain package); `rule-model.test.ts` fails when they drift.
 */
export const WELD_TAX_CODES = [
  'general',
  'saas',
  'digital_goods',
  'services',
  'professional_services',
  'shipping',
  'handling',
  'food_grocery',
  'prepared_food',
  'clothing',
  'prescription_drugs',
  'non_taxable',
] as const;
export type WeldTaxCode = (typeof WELD_TAX_CODES)[number];

export function isWeldTaxCode(value: string): value is WeldTaxCode {
  return (WELD_TAX_CODES as readonly string[]).includes(value);
}

export interface RuleFormValues {
  taxCode: string;
  taxable: boolean;
  /** Blank: 100. */
  taxablePercent: string;
  appliesToUse: RuleUse;
  /** Blank: no override. */
  rateOverride: string;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
}

export function emptyRuleForm(effectiveFrom = ''): RuleFormValues {
  return {
    taxCode: 'saas',
    taxable: true,
    taxablePercent: '100',
    appliesToUse: 'any',
    rateOverride: '',
    effectiveFrom,
    effectiveTo: '',
    notes: '',
  };
}

export function ruleToForm(rule: SalesTaxRule): RuleFormValues {
  return {
    taxCode: rule.taxCode,
    taxable: rule.taxable,
    taxablePercent: formatPercent(rule.taxablePercent) || '100',
    appliesToUse: rule.appliesToUse,
    rateOverride: rule.rateOverride === null ? '' : formatPercent(rule.rateOverride),
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo ?? '',
    notes: rule.notes ?? '',
  };
}

export function makeRuleSchema(texts: ValidationTexts) {
  return z
    .object({
      taxCode: z.string().min(1, texts.required),
      taxable: z.boolean(),
      taxablePercent: z.string(),
      appliesToUse: z.enum(['any', 'business', 'personal']),
      rateOverride: z.string(),
      effectiveFrom: z.string().refine((v) => ISO_DATE.test(v), texts.date),
      effectiveTo: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      notes: z.string().max(2000, texts.tooLong),
    })
    .superRefine((values, ctx) => {
      if (values.taxable) {
        if (values.taxablePercent.trim() !== '' && parsePercent(values.taxablePercent) === null) {
          ctx.addIssue({ code: 'custom', path: ['taxablePercent'], message: texts.percent });
        }
        if (values.rateOverride.trim() !== '' && parsePercent(values.rateOverride) === null) {
          ctx.addIssue({ code: 'custom', path: ['rateOverride'], message: texts.percent });
        }
      }
      if (values.effectiveFrom && values.effectiveTo && values.effectiveTo < values.effectiveFrom) {
        ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: texts.endBeforeStart });
      }
    });
}

/** What a rule that isn't taxable carries: the share and the override mean nothing there. */
function shareAndOverride(values: RuleFormValues): Pick<CreateRuleInput, 'taxablePercent' | 'rateOverride'> {
  if (!values.taxable) return { taxablePercent: 100, rateOverride: null };
  return {
    taxablePercent: values.taxablePercent.trim() === '' ? 100 : (parsePercent(values.taxablePercent) ?? 100),
    rateOverride: values.rateOverride.trim() === '' ? null : parsePercent(values.rateOverride),
  };
}

export function toCreateRuleInput(agencyId: string, values: RuleFormValues): CreateRuleInput {
  const input: CreateRuleInput = {
    agencyId,
    taxCode: values.taxCode,
    taxable: values.taxable,
    appliesToUse: values.appliesToUse,
    effectiveFrom: values.effectiveFrom,
  };
  const { taxablePercent, rateOverride } = shareAndOverride(values);
  input.taxablePercent = taxablePercent;
  if (rateOverride !== null) input.rateOverride = rateOverride;
  if (values.effectiveTo) input.effectiveTo = values.effectiveTo;
  const notes = values.notes.trim();
  if (notes) input.notes = notes;
  return input;
}

/** The update payload: cleared optional fields go as null so they can be emptied. */
export function toUpdateRuleInput(values: RuleFormValues): UpdateRuleInput {
  const { taxablePercent, rateOverride } = shareAndOverride(values);
  return {
    taxCode: values.taxCode,
    taxable: values.taxable,
    taxablePercent,
    appliesToUse: values.appliesToUse,
    rateOverride,
    effectiveFrom: values.effectiveFrom,
    effectiveTo: values.effectiveTo || null,
    notes: values.notes.trim() || null,
  };
}

/** Rules grouped by product, in the order of the code list, each group oldest first. */
export function sortRules<T extends { taxCode: string; effectiveFrom: string }>(rules: readonly T[]): T[] {
  const rank = (code: string) => {
    const index = (WELD_TAX_CODES as readonly string[]).indexOf(code);
    return index === -1 ? WELD_TAX_CODES.length : index;
  };
  return [...rules].sort(
    (a, b) => rank(a.taxCode) - rank(b.taxCode) || a.taxCode.localeCompare(b.taxCode) || a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
}
