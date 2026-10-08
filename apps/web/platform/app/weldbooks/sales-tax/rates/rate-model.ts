/**
 * Jurisdictions and their dated rates without the React: the form values, the
 * validation schemas and the conversions to what the API takes.
 *
 * A rate is a percentage (6.25 means 6.25%) with up to four decimals. Rates of
 * one jurisdiction never overlap, so adding a rate offers to end the one that
 * has no end date the day before the new one starts ("close previous").
 */
import { z } from 'zod';
import type {
  CreateJurisdictionInput,
  CreateRateInput,
  JurisdictionLevel,
  JurisdictionRate,
  SalesTaxJurisdiction,
  UpdateJurisdictionInput,
  UpdateRateInput,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { formatPercent } from '../setup/format';
import type { ValidationTexts } from '../setup/setup-texts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERCENT_TEXT = /^\d{1,3}(?:[.,]\d{1,4})?$/;

/**
 * "6.25", "6,25", " 8.25 % " as a number from 0 to 100; null when it isn't a
 * percentage with at most four decimals.
 */
export function parsePercent(text: string): number | null {
  const cleaned = text.replace(/%/g, '').trim();
  if (!PERCENT_TEXT.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** The day before an ISO date (the end of the rate a new one replaces). */
export function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** The rate without an end date that started before `effectiveFrom`: the one "close previous" would end. */
export function openEndedRateBefore(rates: readonly JurisdictionRate[], effectiveFrom: string): JurisdictionRate | undefined {
  if (!ISO_DATE.test(effectiveFrom)) return undefined;
  return rates.find((r) => !r.effectiveTo && r.effectiveFrom < effectiveFrom);
}

/** The rate in force on `day`; the latest start wins. */
export function rateOn(rates: readonly JurisdictionRate[], day: string): JurisdictionRate | undefined {
  return [...rates]
    .filter((r) => r.effectiveFrom <= day && (!r.effectiveTo || r.effectiveTo >= day))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

// ============================================================================
// A rate
// ============================================================================

export interface RateFormValues {
  rate: string;
  effectiveFrom: string;
  effectiveTo: string;
  closePrevious: boolean;
}

export function emptyRateForm(effectiveFrom = ''): RateFormValues {
  return { rate: '', effectiveFrom, effectiveTo: '', closePrevious: false };
}

export function rateToForm(rate: JurisdictionRate): RateFormValues {
  return {
    rate: formatPercent(rate.rate),
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo ?? '',
    closePrevious: false,
  };
}

export function makeRateSchema(texts: ValidationTexts) {
  return z
    .object({
      rate: z
        .string()
        .trim()
        .min(1, texts.rateRequired)
        .refine((v) => parsePercent(v) !== null, texts.percent),
      effectiveFrom: z.string().refine((v) => ISO_DATE.test(v), texts.date),
      effectiveTo: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      closePrevious: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (values.effectiveFrom && values.effectiveTo && values.effectiveTo < values.effectiveFrom) {
        ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: texts.endBeforeStart });
      }
    });
}

/**
 * The payload to add a rate. `closePrevious` is sent only when the user chose
 * it, so the server's overlap check still guards every other case.
 */
export function toCreateRateInput(values: RateFormValues): CreateRateInput {
  const input: CreateRateInput = {
    rate: parsePercent(values.rate) ?? 0,
    effectiveFrom: values.effectiveFrom,
  };
  if (values.effectiveTo) input.effectiveTo = values.effectiveTo;
  if (values.closePrevious) input.closePrevious = true;
  return input;
}

/** The payload to change a rate: a cleared end date is sent as null. */
export function toUpdateRateInput(values: RateFormValues): UpdateRateInput {
  return {
    rate: parsePercent(values.rate) ?? 0,
    effectiveFrom: values.effectiveFrom,
    effectiveTo: values.effectiveTo || null,
  };
}

// ============================================================================
// A jurisdiction
// ============================================================================

export interface JurisdictionFormValues {
  level: JurisdictionLevel;
  name: string;
  code: string;
  reportingCode: string;
  isActive: boolean;
  /** Adding only: the first rate. */
  rate: string;
  effectiveFrom: string;
}

export function emptyJurisdictionForm(effectiveFrom = ''): JurisdictionFormValues {
  return { level: 'state', name: '', code: '', reportingCode: '', isActive: true, rate: '', effectiveFrom };
}

export function jurisdictionToForm(jurisdiction: SalesTaxJurisdiction): JurisdictionFormValues {
  return {
    level: jurisdiction.level,
    name: jurisdiction.name,
    code: jurisdiction.code ?? '',
    reportingCode: jurisdiction.reportingCode ?? '',
    isActive: jurisdiction.isActive,
    rate: '',
    effectiveFrom: '',
  };
}

/** `mode: 'create'` also checks the first rate. */
export function makeJurisdictionSchema(texts: ValidationTexts, mode: 'create' | 'edit') {
  return z
    .object({
      level: z.enum(['state', 'county', 'city', 'district']),
      name: z.string().trim().min(1, texts.required).max(255, texts.tooLong),
      code: z.string().max(30, texts.tooLong),
      reportingCode: z.string().max(30, texts.tooLong),
      isActive: z.boolean(),
      rate: z.string(),
      effectiveFrom: z.string(),
    })
    .superRefine((values, ctx) => {
      if (mode !== 'create') return;
      if (!values.rate.trim()) {
        ctx.addIssue({ code: 'custom', path: ['rate'], message: texts.rateRequired });
      } else if (parsePercent(values.rate) === null) {
        ctx.addIssue({ code: 'custom', path: ['rate'], message: texts.percent });
      }
      if (!ISO_DATE.test(values.effectiveFrom)) {
        ctx.addIssue({ code: 'custom', path: ['effectiveFrom'], message: texts.date });
      }
    });
}

export function toCreateJurisdictionInput(agencyId: string, values: JurisdictionFormValues): CreateJurisdictionInput {
  const input: CreateJurisdictionInput = {
    agencyId,
    level: values.level,
    name: values.name.trim(),
    isActive: values.isActive,
    rate: { rate: parsePercent(values.rate) ?? 0, effectiveFrom: values.effectiveFrom },
  };
  const code = values.code.trim();
  if (code) input.code = code;
  const reportingCode = values.reportingCode.trim();
  if (reportingCode) input.reportingCode = reportingCode;
  return input;
}

/** A cleared code is sent as null so it can be emptied. */
export function toUpdateJurisdictionInput(values: JurisdictionFormValues): UpdateJurisdictionInput {
  return {
    level: values.level,
    name: values.name.trim(),
    code: values.code.trim() || null,
    reportingCode: values.reportingCode.trim() || null,
    isActive: values.isActive,
  };
}

/** The jurisdiction levels in the order a return lists them. */
export const JURISDICTION_LEVEL_ORDER: readonly JurisdictionLevel[] = ['state', 'county', 'city', 'district'];

/** Sort: state, county, city, district; then by name. */
export function sortJurisdictions<T extends { level: JurisdictionLevel; name: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      JURISDICTION_LEVEL_ORDER.indexOf(a.level) - JURISDICTION_LEVEL_ORDER.indexOf(b.level) || a.name.localeCompare(b.name),
  );
}
