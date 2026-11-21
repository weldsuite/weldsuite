/**
 * The replenishment settings form: the text the inputs hold and the PATCH body
 * the API takes (ranges as the contract states them). Pure, so it is tested
 * apart from the form.
 */

import { z } from 'zod';
import {
  updateReplenishmentSettingsSchema,
  type ReplenishmentSettings,
  type UpdateReplenishmentSettingsInput,
} from '@weldsuite/app-api-client/schemas/replenishment';

export interface SettingsFormValues {
  replenishmentEnabled: boolean;
  /** A percentage: 95 for 0.95. */
  serviceLevelPct: string;
  reviewPeriodDays: string;
  lookbackDays: string;
  defaultLeadTimeDays: string;
  /** Empty: the warehouse marked as default. */
  demandWarehouseId: string;
  /** `YYYY-MM-DD`, or empty for none. */
  historyCutoverDate: string;
  runHourUtc: string;
}

export type SettingsFormField = keyof SettingsFormValues;

export function settingsToForm(settings: ReplenishmentSettings): SettingsFormValues {
  return {
    replenishmentEnabled: settings.replenishmentEnabled,
    serviceLevelPct: String(Math.round(Number(settings.defaultServiceLevel) * 1000) / 10),
    reviewPeriodDays: String(settings.defaultReviewPeriodDays),
    lookbackDays: String(settings.lookbackDays),
    defaultLeadTimeDays: String(settings.defaultLeadTimeDays),
    demandWarehouseId: settings.demandWarehouseId ?? '',
    historyCutoverDate: settings.historyCutoverDate ?? '',
    runHourUtc: String(settings.runHourUtc),
  };
}

function whole(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

export type SettingsFormResult =
  | { ok: true; input: UpdateReplenishmentSettingsInput }
  | { ok: false; errors: Partial<Record<SettingsFormField, 'invalid'>> };

/** The PATCH body for the form, or the fields the API would refuse. */
export function formToSettingsInput(values: SettingsFormValues): SettingsFormResult {
  const errors: Partial<Record<SettingsFormField, 'invalid'>> = {};
  const percent = Number(values.serviceLevelPct.trim().replace(',', '.'));
  const review = whole(values.reviewPeriodDays);
  const lookback = whole(values.lookbackDays);
  const lead = whole(values.defaultLeadTimeDays);
  const hour = whole(values.runHourUtc);

  if (values.serviceLevelPct.trim() === '' || !Number.isFinite(percent)) errors.serviceLevelPct = 'invalid';
  if (review === null) errors.reviewPeriodDays = 'invalid';
  if (lookback === null) errors.lookbackDays = 'invalid';
  if (lead === null) errors.defaultLeadTimeDays = 'invalid';
  if (hour === null) errors.runHourUtc = 'invalid';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = updateReplenishmentSettingsSchema.safeParse({
    replenishmentEnabled: values.replenishmentEnabled,
    defaultServiceLevel: Math.round(percent * 10) / 1000,
    defaultReviewPeriodDays: review,
    lookbackDays: lookback,
    defaultLeadTimeDays: lead,
    demandWarehouseId: values.demandWarehouseId || null,
    historyCutoverDate: values.historyCutoverDate || null,
    runHourUtc: hour,
  });
  if (parsed.success) return { ok: true, input: parsed.data };

  const out: Partial<Record<SettingsFormField, 'invalid'>> = {};
  for (const issue of parsed.error.issues) {
    switch (issue.path[0]) {
      case 'defaultServiceLevel':
        out.serviceLevelPct = 'invalid';
        break;
      case 'defaultReviewPeriodDays':
        out.reviewPeriodDays = 'invalid';
        break;
      case 'lookbackDays':
        out.lookbackDays = 'invalid';
        break;
      case 'defaultLeadTimeDays':
        out.defaultLeadTimeDays = 'invalid';
        break;
      case 'historyCutoverDate':
        out.historyCutoverDate = 'invalid';
        break;
      case 'runHourUtc':
        out.runHourUtc = 'invalid';
        break;
      default:
        break;
    }
  }
  return { ok: false, errors: out };
}

/** The zod schema the form validates with, with one message for every invalid field. */
export function makeSettingsFormSchema(invalidMessage: string) {
  return z
    .object({
      replenishmentEnabled: z.boolean(),
      serviceLevelPct: z.string(),
      reviewPeriodDays: z.string(),
      lookbackDays: z.string(),
      defaultLeadTimeDays: z.string(),
      demandWarehouseId: z.string(),
      historyCutoverDate: z.string(),
      runHourUtc: z.string(),
    })
    .superRefine((values, ctx) => {
      const result = formToSettingsInput(values);
      if (result.ok) return;
      for (const field of Object.keys(result.errors) as SettingsFormField[]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: invalidMessage });
      }
    });
}
