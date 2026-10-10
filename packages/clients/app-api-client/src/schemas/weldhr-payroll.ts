/**
 * WeldHR payroll request schemas — shared by hr-api (validation) and the
 * platform (form typing). Zod v3. Routes: /api/weldhr/payroll/* and the
 * payroll parts of /api/weldhr/me and the workforce portal.
 *
 * Money in requests is a decimal number in currency units (`2750.5`); the
 * server converts to cents. Responses carry decimal strings for stored
 * amounts and integer cents inside payslip lines (see domains/weldhr-payroll).
 */

import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const id = z.string().min(1).max(30);
const shortText = (max: number) => z.string().trim().max(max);
const money = z.number().finite().min(-10_000_000).max(10_000_000);
const nonNegativeMoney = z.number().finite().min(0).max(10_000_000);
const percent = z.number().finite().min(0).max(100);
const usState = z.string().regex(/^[A-Z]{2}$/, 'Expected a two-letter state code');

export const hrPayrollCountrySchema = z.enum(['NL', 'US']);
export const hrPayFrequencySchema = z.enum(['monthly', 'four_weekly', 'semimonthly', 'biweekly', 'weekly']);
export const hrPayRunKindSchema = z.enum(['regular', 'off_cycle', 'correction']);
export const hrPayRunStatusSchema = z.enum(['draft', 'calculated', 'approved', 'paid', 'cancelled']);
export const hrPayrollFilingStatusSchema = z.enum(['open', 'ready', 'submitted', 'accepted', 'rejected', 'filed']);

// ---------------------------------------------------------------------------
// Employers
// ---------------------------------------------------------------------------

export const hrPayrollAddressSchema = z.object({
  line1: shortText(255).nullable().optional(),
  line2: shortText(255).nullable().optional(),
  houseNumber: shortText(20).nullable().optional(),
  houseNumberAddition: shortText(20).nullable().optional(),
  postalCode: shortText(20).nullable().optional(),
  city: shortText(120).nullable().optional(),
  region: shortText(120).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
});

export const hrPayrollEmployerNlSettingsSchema = z.object({
  loonheffingennummer: z
    .string()
    .trim()
    .regex(/^\d{9}L\d{2}$/i, 'Expected a loonheffingennummer like 123456789L01')
    .nullable()
    .optional(),
  sectorCode: z.number().int().min(1).max(99).nullable().optional(),
  years: z
    .record(
      z.string().regex(/^\d{4}$/),
      z.object({
        whkRate: percent.nullable().optional(),
        aofSmallEmployer: z.boolean().nullable().optional(),
      }),
    )
    .optional(),
  holidayAllowancePercent: percent.nullable().optional(),
  holidayAllowancePayoutMonth: z.number().int().min(1).max(12).nullable().optional(),
  payslipLanguage: z.enum(['nl', 'en']).nullable().optional(),
  contactName: shortText(120).nullable().optional(),
  contactPhone: shortText(40).nullable().optional(),
});

export const hrPayrollEmployerUsStateSchema = z.object({
  withholdingAccountNumber: shortText(60).nullable().optional(),
  suiAccountNumber: shortText(60).nullable().optional(),
  suiRates: z.record(z.string().regex(/^\d{4}$/), percent).optional(),
  extraRates: z.record(z.string().regex(/^\d{4}$/), z.record(z.string().max(60), percent)).optional(),
});

export const hrPayrollEmployerUsSettingsSchema = z.object({
  ein: z
    .string()
    .trim()
    .regex(/^\d{2}-?\d{7}$/, 'Expected an EIN like 12-3456789')
    .nullable()
    .optional(),
  depositSchedule: z.enum(['monthly', 'semiweekly']).nullable().optional(),
  workweekStartDay: z.number().int().min(0).max(6).nullable().optional(),
  states: z.record(usState, hrPayrollEmployerUsStateSchema).optional(),
  employeeCountEstimate: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

export const createHrPayrollEmployerSchema = z.object({
  name: shortText(160).min(1),
  legalName: shortText(255).min(1),
  country: hrPayrollCountrySchema,
  /** Defaults to EUR (NL) / USD (US). */
  currency: z.string().length(3).optional(),
  accountingEntityId: id.nullable().optional(),
  address: hrPayrollAddressSchema.optional(),
  nlSettings: hrPayrollEmployerNlSettingsSchema.optional(),
  usSettings: hrPayrollEmployerUsSettingsSchema.optional(),
  requireSeparateApprover: z.boolean().optional(),
});
export const updateHrPayrollEmployerSchema = createHrPayrollEmployerSchema
  .omit({ country: true, currency: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

/** The account salaries are paid from. Write-only; reads come back masked. */
export const hrPayrollEmployerBankSchema = z.object({
  accountHolder: shortText(140).nullable().optional(),
  iban: z.string().trim().max(34).nullable().optional(),
  bic: z.string().trim().max(11).nullable().optional(),
  routingNumber: z.string().trim().regex(/^\d{9}$/, 'Expected a 9-digit routing number').nullable().optional(),
  accountNumber: z.string().trim().regex(/^\d{4,17}$/, 'Expected 4–17 digits').nullable().optional(),
  accountType: z.enum(['checking', 'savings']).nullable().optional(),
  nachaCompanyId: z.string().trim().max(10).nullable().optional(),
  bankName: shortText(23).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Pay schedules
// ---------------------------------------------------------------------------

export const hrPayDateRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('day_of_month'), day: z.number().int().min(1).max(31) }),
  z.object({ kind: z.literal('offset_after_end'), days: z.number().int().min(-14).max(31) }),
  z.object({ kind: z.literal('last_business_day') }),
]);

export const createHrPayScheduleSchema = z.object({
  employerId: id,
  name: shortText(120).min(1),
  frequency: hrPayFrequencySchema,
  anchorDate: isoDate,
  payDateRule: hrPayDateRuleSchema,
});
export const updateHrPayScheduleSchema = createHrPayScheduleSchema
  .omit({ employerId: true, frequency: true, anchorDate: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

// ---------------------------------------------------------------------------
// Employee payroll setup
// ---------------------------------------------------------------------------

export const hrPayrollProfileNlSchema = z.object({
  writtenContract: z.boolean().optional(),
  indefiniteContract: z.boolean().optional(),
  onCall: z.boolean().optional(),
  isDga: z.boolean().optional(),
  insuredWw: z.boolean().nullable().optional(),
  insuredZw: z.boolean().nullable().optional(),
  insuredWao: z.boolean().nullable().optional(),
  incomeRelationshipNumber: z.number().int().min(1).max(999_999_999).nullable().optional(),
  caoCode: z.number().int().min(0).max(9999).nullable().optional(),
  /** Code reden einde arbeidsverhouding (two digits, e.g. `30` end of a fixed-term contract). */
  endReasonCode: z.string().regex(/^\d{2}$/, 'Expected a two-digit code').nullable().optional(),
  /** Days per week the employee usually works; empty = 5 from 36 contract hours, otherwise 4. */
  usualWorkDaysPerWeek: z.number().min(1).max(7).nullable().optional(),
  expatRuling: z
    .object({ from: isoDate, to: isoDate.nullable().optional(), percent: percent })
    .nullable()
    .optional(),
  surnamePrefix: shortText(20).nullable().optional(),
  initials: shortText(20).nullable().optional(),
  gender: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable().optional(),
  nationality: z.string().length(2).nullable().optional(),
  contractHoursPerWeek: z.number().min(0).max(80).nullable().optional(),
});

export const hrPayrollProfileUsSchema = z.object({
  workState: usState.nullable().optional(),
  residenceState: usState.nullable().optional(),
  flsaStatus: z.enum(['exempt', 'nonexempt']).nullable().optional(),
  statutoryEmployee: z.boolean().optional(),
  retirementPlan: z.boolean().optional(),
  exemptFica: z.boolean().optional(),
  exemptFuta: z.boolean().optional(),
});

/** Put an employee on (or change their) payroll. */
export const upsertHrPayrollProfileSchema = z.object({
  employerId: id,
  payScheduleId: id.nullable().optional(),
  status: z.enum(['active', 'paused', 'ended']).optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  nl: hrPayrollProfileNlSchema.optional(),
  us: hrPayrollProfileUsSchema.optional(),
});

export const createHrCompensationSchema = z.object({
  effectiveFrom: isoDate,
  payType: z.enum(['salary', 'hourly']),
  amount: nonNegativeMoney,
  period: z.enum(['hour', 'week', 'month', 'year']),
  currency: z.string().length(3).optional(),
  hoursPerWeek: z.number().min(0).max(80).nullable().optional(),
  reason: z.string().max(1000).nullable().optional(),
  /**
   * A compensation that starts on or before the last approved pay period is refused
   * (it would change pay that was already paid). Set this to confirm it is retroactive,
   * e.g. to back-date a raise before correcting the affected pay runs.
   */
  allowRetroactive: z.boolean().optional(),
});

const componentParams = z.record(z.string().max(60), z.union([z.number(), z.string().max(200), z.boolean(), z.null()]));

export const createHrPayComponentSchema = z.object({
  code: z.string().min(1).max(60),
  label: shortText(160).nullable().optional(),
  amount: money.nullable().optional(),
  params: componentParams.optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
});
export const updateHrPayComponentSchema = createHrPayComponentSchema.omit({ code: true }).partial();

export const hrNlLoonheffingskortingElectionSchema = z.object({ applyCredit: z.boolean() });

export const hrUsW4ElectionSchema = z.object({
  formYear: z.number().int().min(1990).max(2100),
  filingStatus: z.enum(['single', 'married_jointly', 'head_of_household']),
  multipleJobs: z.boolean(),
  dependentsAmount: nonNegativeMoney,
  otherIncome: nonNegativeMoney,
  deductions: nonNegativeMoney,
  extraWithholding: nonNegativeMoney,
  exempt: z.boolean(),
  allowances: z.number().int().min(0).max(99).nullable().optional(),
  nonresidentAlien: z.boolean().optional(),
});

export const hrUsStateCertificateElectionSchema = z.object({
  filingStatus: shortText(40).nullable().optional(),
  allowances: z.number().int().min(0).max(99).nullable().optional(),
  values: z.record(z.string().max(60), z.union([z.number(), z.string().max(60), z.boolean(), z.null()])).optional(),
  extraWithholding: nonNegativeMoney.nullable().optional(),
  exempt: z.boolean().optional(),
});

/** A signed tax election. The employee signs their own through /me or the portal; HR enters paper forms. */
export const createHrTaxElectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('nl_loonheffingskorting'),
    effectiveFrom: isoDate,
    data: hrNlLoonheffingskortingElectionSchema,
    signatureName: shortText(255).min(1),
  }),
  z.object({
    kind: z.literal('us_w4'),
    effectiveFrom: isoDate,
    data: hrUsW4ElectionSchema,
    signatureName: shortText(255).min(1),
  }),
  z.object({
    kind: z.literal('us_state_certificate'),
    state: usState,
    effectiveFrom: isoDate,
    data: hrUsStateCertificateElectionSchema,
    signatureName: shortText(255).min(1),
  }),
]);

/**
 * The identity and bank details payroll needs, written into the employee's
 * encrypted sensitive block. `undefined` keeps a field, `null` clears it.
 */
export const hrPayrollPaymentDetailsSchema = z.object({
  /** BSN (NL, 9 digits, elfproef) or SSN (US, 9 digits). */
  nationalId: z.string().trim().regex(/^\d{3}-?\d{2}-?\d{4}$|^\d{8,9}$/, 'Expected a BSN or SSN').nullable().optional(),
  dateOfBirth: isoDate.nullable().optional(),
  bankAccountHolder: shortText(140).nullable().optional(),
  bankIban: z.string().trim().max(34).nullable().optional(),
  bankBic: z.string().trim().max(11).nullable().optional(),
  bankRoutingNumber: z.string().trim().regex(/^\d{9}$/, 'Expected a 9-digit routing number').nullable().optional(),
  bankAccountNumber: z.string().trim().regex(/^\d{4,17}$/, 'Expected 4–17 digits').nullable().optional(),
  bankAccountType: z.enum(['checking', 'savings']).nullable().optional(),
  homeAddress: hrPayrollAddressSchema.nullable().optional(),
  idDocumentType: z.enum(['passport', 'id_card', 'residence_permit', 'drivers_license']).nullable().optional(),
  idDocumentNumber: shortText(40).nullable().optional(),
  idDocumentExpiresOn: isoDate.nullable().optional(),
  /** HR only: when they checked the ID document. Ignored from self-service. */
  idVerifiedAt: isoDate.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Pay runs
// ---------------------------------------------------------------------------

export const createHrPayRunSchema = z
  .object({
    employerId: id,
    kind: hrPayRunKindSchema.default('regular'),
    /** Regular runs: the schedule; the next unpaid period is used unless `periodStart` is given. */
    payScheduleId: id.nullable().optional(),
    periodStart: isoDate.optional(),
    periodEnd: isoDate.optional(),
    payDate: isoDate.optional(),
    /** Off-cycle and correction runs: who is in it. */
    employeeIds: z.array(id).max(1000).optional(),
    /** Correction runs: the approved run being corrected. */
    correctsRunId: id.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'regular' && !value.payScheduleId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payScheduleId'], message: 'A regular run needs a pay schedule' });
    }
    if (value.kind === 'correction' && !value.correctsRunId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['correctsRunId'], message: 'A correction run needs the run it corrects' });
    }
    if (value.kind !== 'regular' && (!value.periodStart || !value.periodEnd || !value.payDate) && value.kind !== 'correction') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodStart'], message: 'An off-cycle run needs its period and pay date' });
    }
  });

export const updateHrPayRunSchema = z.object({
  payDate: isoDate.optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const setHrPayRunEmployeeSchema = z.object({
  employeeId: id,
  /** True leaves the employee out of this run. */
  excluded: z.boolean(),
});

export const createHrPayRunInputSchema = z.object({
  employeeId: id,
  code: z.string().min(1).max(60),
  label: shortText(160).nullable().optional(),
  quantity: z.number().finite().min(-10_000).max(10_000).nullable().optional(),
  rate: z.number().finite().min(0).max(100_000).nullable().optional(),
  amount: money.nullable().optional(),
  workDate: isoDate.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export const updateHrPayRunInputSchema = createHrPayRunInputSchema.omit({ employeeId: true, code: true }).partial();

export const markHrPayRunPaidSchema = z.object({
  paidOn: isoDate.optional(),
});

// ---------------------------------------------------------------------------
// Filings
// ---------------------------------------------------------------------------

export const markHrPayrollFilingFiledSchema = z.object({
  externalReference: shortText(120).nullable().optional(),
  filedOn: isoDate.optional(),
});

// ---------------------------------------------------------------------------
// Inferred inputs
// ---------------------------------------------------------------------------

export type CreateHrPayrollEmployerInput = z.input<typeof createHrPayrollEmployerSchema>;
export type UpdateHrPayrollEmployerInput = z.input<typeof updateHrPayrollEmployerSchema>;
export type HrPayrollEmployerBankInput = z.input<typeof hrPayrollEmployerBankSchema>;
export type CreateHrPayScheduleInput = z.input<typeof createHrPayScheduleSchema>;
export type UpdateHrPayScheduleInput = z.input<typeof updateHrPayScheduleSchema>;
export type UpsertHrPayrollProfileInput = z.input<typeof upsertHrPayrollProfileSchema>;
export type CreateHrCompensationInput = z.input<typeof createHrCompensationSchema>;
export type CreateHrPayComponentInput = z.input<typeof createHrPayComponentSchema>;
export type UpdateHrPayComponentInput = z.input<typeof updateHrPayComponentSchema>;
export type CreateHrTaxElectionInput = z.input<typeof createHrTaxElectionSchema>;
export type HrPayrollPaymentDetailsInput = z.input<typeof hrPayrollPaymentDetailsSchema>;
export type CreateHrPayRunInput = z.input<typeof createHrPayRunSchema>;
export type UpdateHrPayRunInput = z.input<typeof updateHrPayRunSchema>;
export type SetHrPayRunEmployeeInput = z.input<typeof setHrPayRunEmployeeSchema>;
export type CreateHrPayRunInputInput = z.input<typeof createHrPayRunInputSchema>;
export type UpdateHrPayRunInputInput = z.input<typeof updateHrPayRunInputSchema>;
export type MarkHrPayRunPaidInput = z.input<typeof markHrPayRunPaidSchema>;
export type MarkHrPayrollFilingFiledInput = z.input<typeof markHrPayrollFilingFiledSchema>;
