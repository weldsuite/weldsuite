import { z } from 'zod';
import type { AccountingEntity, UpdateAccountingEntityInput } from '@/lib/api/domains/weldbooks';
import type { WeekFiscalYearConfig } from '@/lib/weldbooks/fiscal-year';
import { startMonthOfWeekYear } from '@/lib/weldbooks/fiscal-year';
import {
  einProblem,
  normalizeEin,
  normalizeSsn,
  ssnProblem,
  validClassification,
  type UsAccountingMethod,
  type UsEntityTypeSummary,
} from '@/lib/weldbooks/us-entity';

/** Sentinel of the time zone select: let the server pick the zone from the state. */
export const TIME_ZONE_AUTO = '__auto__';

export type FiscalYearKind = 'month' | 'weeks';

/** The US-only part of the entity form. Kept as one nested form value, like the address. */
export interface UsEntityValues {
  /** One of the server's US entity types; '' for a legacy entity that still carries a free-form type. */
  entityType: string;
  taxClassification: string;
  dba: string;
  /** EIN as typed, `XX-XXXXXXX`. */
  ein: string;
  /** A new SSN to store, as typed. Empty keeps the stored one. */
  ssn: string;
  /** Remove the stored SSN on save. */
  clearSsn: boolean;
  /** State tax registration number (`taxIdentifiers.registrationNumber`). */
  stateTaxId: string;
  accountingMethod: UsAccountingMethod;
  fiscalYearKind: FiscalYearKind;
  /** 1-12, as a string for the select. */
  fiscalYearStart: string;
  fiscalEndMonth: string;
  /** 0 = Sunday ... 6 = Saturday, as a string for the select. */
  fiscalWeekday: string;
  fiscalRule: 'last' | 'nearest';
  /** IANA zone, or `TIME_ZONE_AUTO`. */
  timezone: string;
}

export const DEFAULT_US_VALUES: UsEntityValues = {
  entityType: '',
  taxClassification: '',
  dba: '',
  ein: '',
  ssn: '',
  clearSsn: false,
  stateTaxId: '',
  accountingMethod: 'accrual',
  fiscalYearKind: 'month',
  fiscalYearStart: '1',
  fiscalEndMonth: '12',
  fiscalWeekday: '0',
  fiscalRule: 'last',
  timezone: TIME_ZONE_AUTO,
};

/** What the form shows for an entity row. */
export function usValuesFromEntity(
  entity: AccountingEntity,
  entityTypes: readonly UsEntityTypeSummary[] | undefined,
): UsEntityValues {
  const ids = entity.taxIdentifiers ?? {};
  const known = entityTypes?.some((t) => t.type === entity.entityType) ?? false;
  // A Social Security number typed into the EIN field before it was checked comes back masked: don't offer it as an EIN.
  const storedEin = ids.einOrSsn ?? ids.vatNumber ?? '';
  const entityType = known ? (entity.entityType ?? '') : '';
  const weeks = entity.fiscalYearConfig;
  return {
    entityType,
    taxClassification: entityType ? validClassification(entityTypes, entityType, entity.taxClassification) : '',
    dba: entity.dba ?? '',
    ein: /^\d{2}-\d{7}$/.test(storedEin) ? storedEin : '',
    ssn: '',
    clearSsn: false,
    stateTaxId: ids.registrationNumber ?? '',
    accountingMethod: entity.accountingMethod === 'cash' ? 'cash' : 'accrual',
    fiscalYearKind: weeks ? 'weeks' : 'month',
    fiscalYearStart: String(entity.fiscalYearStart ?? 1),
    fiscalEndMonth: String(weeks?.endMonth ?? 12),
    fiscalWeekday: String(weeks?.weekday ?? 0),
    fiscalRule: weeks?.rule ?? 'last',
    timezone: entity.timezone || TIME_ZONE_AUTO,
  };
}

export interface UsEntitySchemaMessages {
  entityTypeRequired: string;
  classificationRequired: string;
  einInvalidFormat: string;
  einInvalidPrefix: string;
  ssnInvalid: string;
}

/**
 * Validation of the US values. `requireType` is on for a new entity: an
 * existing entity with an older free-form type may keep it until someone picks
 * a US type.
 */
export function createUsEntitySchema(messages: UsEntitySchemaMessages, options: { requireType: boolean }) {
  return z
    .object({
      entityType: z.string(),
      taxClassification: z.string(),
      dba: z.string(),
      ein: z.string(),
      ssn: z.string(),
      clearSsn: z.boolean(),
      stateTaxId: z.string(),
      accountingMethod: z.enum(['accrual', 'cash']),
      fiscalYearKind: z.enum(['month', 'weeks']),
      fiscalYearStart: z.string(),
      fiscalEndMonth: z.string(),
      fiscalWeekday: z.string(),
      fiscalRule: z.enum(['last', 'nearest']),
      timezone: z.string(),
    })
    .superRefine((value, ctx) => {
      if (options.requireType && !value.entityType) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entityType'], message: messages.entityTypeRequired });
      }
      if (value.entityType && !value.taxClassification) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxClassification'], message: messages.classificationRequired });
      }
      const ein = einProblem(value.ein);
      if (ein) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ein'],
          message: ein === 'prefix' ? messages.einInvalidPrefix : messages.einInvalidFormat,
        });
      }
      if (value.ssn && ssnProblem(value.ssn)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ssn'], message: messages.ssnInvalid });
      }
    });
}

export function weekFiscalYearConfig(
  values: Pick<UsEntityValues, 'fiscalEndMonth' | 'fiscalWeekday' | 'fiscalRule'>,
): WeekFiscalYearConfig {
  return {
    type: 'fifty_two_fifty_three',
    endMonth: Number(values.fiscalEndMonth),
    weekday: Number(values.fiscalWeekday),
    rule: values.fiscalRule,
  };
}

/** The fiscal year fields of a create or update request. */
export function fiscalYearPayload(
  values: UsEntityValues,
): Pick<UpdateAccountingEntityInput, 'fiscalYearStart' | 'fiscalYearConfig'> {
  if (values.fiscalYearKind === 'weeks') {
    const config = weekFiscalYearConfig(values);
    return { fiscalYearConfig: config, fiscalYearStart: startMonthOfWeekYear(config) };
  }
  // A month-based year replaces a 52-53-week one; the server clears the config when only the month is sent.
  return { fiscalYearStart: Number(values.fiscalYearStart) };
}

/** Fields of a create or update request that every US entity form sets. */
export function usPayload(
  values: UsEntityValues,
): Pick<
  UpdateAccountingEntityInput,
  'entityType' | 'taxClassification' | 'dba' | 'accountingMethod' | 'fiscalYearStart' | 'fiscalYearConfig' | 'timezone'
> {
  const payload: ReturnType<typeof usPayload> = {
    dba: values.dba.trim() || null,
    accountingMethod: values.accountingMethod,
    ...fiscalYearPayload(values),
  };
  // A legacy entity that still carries a free-form type keeps it until a US type is chosen.
  if (values.entityType) {
    payload.entityType = values.entityType;
    if (values.taxClassification) payload.taxClassification = values.taxClassification;
  }
  if (values.timezone && values.timezone !== TIME_ZONE_AUTO) payload.timezone = values.timezone;
  return payload;
}

/** The EIN in canonical form, or undefined when empty. */
export function einPayload(values: UsEntityValues): string | undefined {
  const ein = values.ein.trim();
  return ein ? normalizeEin(ein) : undefined;
}

/** `ssn` of an update: a new number, `null` to remove the stored one, undefined to leave it. */
export function ssnPayload(values: UsEntityValues): string | null | undefined {
  if (values.ssn.trim()) return normalizeSsn(values.ssn);
  if (values.clearSsn) return null;
  return undefined;
}
