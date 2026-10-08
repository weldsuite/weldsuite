/**
 * The agency registration form without the React: the values it edits, the
 * validation schema, and the conversions to what the API takes.
 *
 * Every field is a string (or a boolean) so a blank is a blank. A registration
 * that charges tax (registered or pending) needs the date it starts: a missing
 * date would mean "registered for all dates" and tax back-dated invoices.
 */
import { z } from 'zod';
import type {
  AgencyStatus,
  CreateAgencyInput,
  FilingFrequency,
  ReportingBasis,
  SalesTaxAgency,
  UpdateAgencyInput,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import {
  defaultAgencyName,
  defaultDueDayNumber,
  getSalesTaxState,
  type SalesTaxStateInfo,
} from '@/lib/weldbooks/us-sales-tax-states';
import type { ValidationTexts } from '../setup/setup-texts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What a new registration can start as; `closed` is reached from the agency page. */
export const NEW_AGENCY_STATUSES = ['registered', 'pending', 'monitoring'] as const;
export type NewAgencyStatus = (typeof NEW_AGENCY_STATUSES)[number];

export interface AgencyFormValues {
  stateCode: string;
  /** A city or district that collects its own tax (home-rule states only). */
  local: boolean;
  localJurisdictionCode: string;
  /** Blank: the state's own agency name (the placeholder shows it). */
  name: string;
  status: NewAgencyStatus;
  registrationNumber: string;
  registeredFrom: string;
  filingFrequency: FilingFrequency;
  /** Blank: the month the registration begins. */
  firstPeriodStart: string;
  dueDay: string;
  reportingBasis: ReportingBasis;
  sstMember: boolean;
  portalUrl: string;
  notes: string;
}

export function emptyAgencyForm(stateCode = ''): AgencyFormValues {
  const values: AgencyFormValues = {
    stateCode: '',
    local: false,
    localJurisdictionCode: '',
    name: '',
    status: 'registered',
    registrationNumber: '',
    registeredFrom: '',
    filingFrequency: 'quarterly',
    firstPeriodStart: '',
    dueDay: '20',
    reportingBasis: 'accrual',
    sstMember: false,
    portalUrl: '',
    notes: '',
  };
  return stateCode ? withStateDefaults(values, stateCode) : values;
}

/** Whether the cash basis is offered: a state-level agency in a state that allows it, or a local agency. */
export function cashBasisAvailable(state: SalesTaxStateInfo | undefined, local: boolean): boolean {
  if (!state) return false;
  return local || state.cashBasisAllowed;
}

/** Whether the state has self-administered local agencies (Colorado's home-rule cities and the like). */
export function stateHasLocalAgencies(state: SalesTaxStateInfo | undefined): boolean {
  return Boolean(state?.specialPrograms?.includes('home_rule_local_agencies'));
}

/**
 * Pick a state: its due day, Streamlined Sales Tax membership and portal fill
 * in as hints, and a cash basis the state doesn't allow falls back to accrual.
 * What the user already typed (number, dates, notes) stays.
 */
export function withStateDefaults(values: AgencyFormValues, stateCode: string): AgencyFormValues {
  const state = getSalesTaxState(stateCode);
  if (!state) return { ...values, stateCode };
  const local = values.local && stateHasLocalAgencies(state);
  return {
    ...values,
    stateCode: state.code,
    local,
    localJurisdictionCode: local ? values.localJurisdictionCode : '',
    name: '',
    dueDay: String(defaultDueDayNumber(state)),
    sstMember: state.sst !== 'none',
    portalUrl: state.portalUrl ?? '',
    reportingBasis: cashBasisAvailable(state, local) ? values.reportingBasis : 'accrual',
  };
}

/** Toggle a local agency: the cash basis is only offered where allowed. */
export function withLocal(values: AgencyFormValues, local: boolean): AgencyFormValues {
  const state = getSalesTaxState(values.stateCode);
  const next = { ...values, local, localJurisdictionCode: local ? values.localJurisdictionCode : '' };
  return cashBasisAvailable(state, local) ? next : { ...next, reportingBasis: 'accrual' };
}

/** The name the agency gets when the user leaves the name blank. */
export function agencyNameFor(values: Pick<AgencyFormValues, 'stateCode' | 'name' | 'local'>): string {
  const typed = values.name.trim();
  if (typed) return typed;
  const state = getSalesTaxState(values.stateCode);
  return state ? defaultAgencyName(state) : '';
}

export function makeAgencySchema(texts: ValidationTexts) {
  return z
    .object({
      stateCode: z.string(),
      local: z.boolean(),
      localJurisdictionCode: z.string().max(30, texts.tooLong),
      name: z.string().max(255, texts.tooLong),
      status: z.enum(NEW_AGENCY_STATUSES),
      registrationNumber: z.string().max(100, texts.tooLong),
      registeredFrom: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      filingFrequency: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']),
      firstPeriodStart: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      dueDay: z.string().refine((v) => /^\d{1,2}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 31, texts.dueDay),
      reportingBasis: z.enum(['accrual', 'cash']),
      sstMember: z.boolean(),
      portalUrl: z.string().max(500, texts.tooLong),
      notes: z.string().max(5000, texts.tooLong),
    })
    .superRefine((values, ctx) => {
      const state = getSalesTaxState(values.stateCode);
      if (!state) {
        ctx.addIssue({ code: 'custom', path: ['stateCode'], message: texts.state });
        return;
      }
      if (values.status !== 'monitoring' && !values.registeredFrom) {
        ctx.addIssue({ code: 'custom', path: ['registeredFrom'], message: texts.registeredFromRequired });
      }
      if (values.reportingBasis === 'cash' && !cashBasisAvailable(state, values.local)) {
        ctx.addIssue({
          code: 'custom',
          path: ['reportingBasis'],
          message: texts.cashBasisNotAllowed.replace('{state}', state.name),
        });
      }
      if (values.local) {
        if (!values.name.trim()) ctx.addIssue({ code: 'custom', path: ['name'], message: texts.localName });
        if (!values.localJurisdictionCode.trim()) {
          ctx.addIssue({ code: 'custom', path: ['localJurisdictionCode'], message: texts.localCode });
        }
      }
      const portal = values.portalUrl.trim();
      if (portal && !/^https?:\/\/\S+$/i.test(portal)) {
        ctx.addIssue({ code: 'custom', path: ['portalUrl'], message: texts.url });
      }
    });
}

/** The create payload: blanks are left out so the server's own defaults apply. */
export function toCreateAgencyInput(values: AgencyFormValues): CreateAgencyInput {
  const state = getSalesTaxState(values.stateCode);
  const basis: ReportingBasis = cashBasisAvailable(state, values.local) ? values.reportingBasis : 'accrual';
  const input: CreateAgencyInput = {
    stateCode: values.stateCode,
    level: values.local ? 'local' : 'state',
    status: values.status,
    filingFrequency: values.filingFrequency,
    dueDay: Number(values.dueDay),
    reportingBasis: basis,
    sstMember: values.sstMember,
  };
  if (values.local) input.localJurisdictionCode = values.localJurisdictionCode.trim();
  const name = values.name.trim();
  if (name) input.name = name;
  const number = values.registrationNumber.trim();
  if (number) input.registrationNumber = number;
  if (values.registeredFrom) input.registeredFrom = values.registeredFrom;
  if (values.firstPeriodStart) input.firstPeriodStart = values.firstPeriodStart;
  const portal = values.portalUrl.trim();
  if (portal) input.portalUrl = portal;
  const notes = values.notes.trim();
  if (notes) input.notes = notes;
  return input;
}

// ============================================================================
// Editing an existing registration
// ============================================================================

export interface AgencyEditValues {
  name: string;
  registrationNumber: string;
  registeredFrom: string;
  registeredUntil: string;
  filingFrequency: FilingFrequency;
  firstPeriodStart: string;
  dueDay: string;
  reportingBasis: ReportingBasis;
  sstMember: boolean;
  portalUrl: string;
  notes: string;
}

export function agencyToEditValues(agency: SalesTaxAgency): AgencyEditValues {
  return {
    name: agency.name,
    registrationNumber: agency.registrationNumber ?? '',
    registeredFrom: agency.registeredFrom ?? '',
    registeredUntil: agency.registeredUntil ?? '',
    filingFrequency: agency.filingFrequency,
    firstPeriodStart: agency.firstPeriodStart ?? '',
    dueDay: String(agency.dueDay),
    reportingBasis: agency.reportingBasis,
    sstMember: agency.sstMember,
    portalUrl: agency.portalUrl ?? '',
    notes: agency.notes ?? '',
  };
}

export function makeAgencyEditSchema(texts: ValidationTexts, agency: Pick<SalesTaxAgency, 'stateCode' | 'level' | 'status'>) {
  return z
    .object({
      name: z.string().trim().min(1, texts.required).max(255, texts.tooLong),
      registrationNumber: z.string().max(100, texts.tooLong),
      registeredFrom: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      registeredUntil: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      filingFrequency: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']),
      firstPeriodStart: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      dueDay: z.string().refine((v) => /^\d{1,2}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 31, texts.dueDay),
      reportingBasis: z.enum(['accrual', 'cash']),
      sstMember: z.boolean(),
      portalUrl: z.string().max(500, texts.tooLong),
      notes: z.string().max(5000, texts.tooLong),
    })
    .superRefine((values, ctx) => {
      const state = getSalesTaxState(agency.stateCode);
      if ((agency.status === 'registered' || agency.status === 'pending') && !values.registeredFrom) {
        ctx.addIssue({ code: 'custom', path: ['registeredFrom'], message: texts.registeredFromRequired });
      }
      if (values.registeredFrom && values.registeredUntil && values.registeredUntil < values.registeredFrom) {
        ctx.addIssue({ code: 'custom', path: ['registeredUntil'], message: texts.endBeforeStart });
      }
      if (values.reportingBasis === 'cash' && !cashBasisAvailable(state, agency.level === 'local')) {
        ctx.addIssue({
          code: 'custom',
          path: ['reportingBasis'],
          message: texts.cashBasisNotAllowed.replace('{state}', state?.name ?? agency.stateCode),
        });
      }
      const portal = values.portalUrl.trim();
      if (portal && !/^https?:\/\/\S+$/i.test(portal)) {
        ctx.addIssue({ code: 'custom', path: ['portalUrl'], message: texts.url });
      }
    });
}

/** The update payload: a cleared optional field is sent as null so it can be emptied. */
export function toUpdateAgencyInput(values: AgencyEditValues): UpdateAgencyInput {
  return {
    name: values.name.trim(),
    registrationNumber: values.registrationNumber.trim() || null,
    registeredFrom: values.registeredFrom || null,
    registeredUntil: values.registeredUntil || null,
    filingFrequency: values.filingFrequency,
    firstPeriodStart: values.firstPeriodStart || null,
    dueDay: Number(values.dueDay),
    reportingBasis: values.reportingBasis,
    sstMember: values.sstMember,
    portalUrl: values.portalUrl.trim() || null,
    notes: values.notes.trim() || null,
  };
}

/** The statuses an agency can move to from where it is. */
export function statusTargets(status: AgencyStatus): AgencyStatus[] {
  return (['registered', 'pending', 'monitoring', 'closed'] as const).filter((s) => s !== status);
}
