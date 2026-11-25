/**
 * The form of one annual report: its values (balance sheet lines of both
 * years, the disclosures, the adoption), the validation and the PATCH body a
 * save sends. Only what changed is sent, so a save never marks figures as
 * hand-edited that nobody touched.
 */

import { z } from 'zod';
import {
  ALL_LINE_KEYS,
  changedLines,
  emptyLines,
  isAnnualReportEditable,
  type AnnualReport,
  type AnnualReportLineKey,
  type AnnualReportLines,
  type AnnualReportPatch,
} from '@/lib/weldbooks/annual-report-model';

/** Lines as typed in: an empty field is `undefined` and counts as 0. */
export type LinesInput = { [K in AnnualReportLineKey]?: number };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const annualReportFormSchema = z.object({
  sizeClass: z.enum(['micro', 'small']),
  current: z.object(Object.fromEntries(ALL_LINE_KEYS.map((key) => [key, z.number().finite().optional()])) as Record<AnnualReportLineKey, z.ZodOptional<z.ZodNumber>>),
  hasPrior: z.boolean(),
  prior: z.object(Object.fromEntries(ALL_LINE_KEYS.map((key) => [key, z.number().finite().optional()])) as Record<AnnualReportLineKey, z.ZodOptional<z.ZodNumber>>),
  disclosures: z.object({
    legalForm: z.enum(['bv', 'nv', '']),
    kvkNumber: z.string().max(20),
    registeredOffice: z.string().max(200),
    city: z.string().max(200),
    postalCode: z.string().max(20),
    email: z.string().max(200),
    preparedOn: z.string().regex(DATE).or(z.literal('')),
    appropriation: z.enum(['before', 'after']),
    averageEmployees: z.number().int().min(0).optional(),
  }),
  adopted: z.boolean(),
  adoptionDate: z.string().regex(DATE).or(z.literal('')),
  notes: z.string().max(5000),
});

export type AnnualReportFormValues = z.infer<typeof annualReportFormSchema>;

/** Typed-in lines with the empty ones as 0. */
export function normalizeLines(input: LinesInput | undefined): AnnualReportLines {
  const lines = emptyLines();
  for (const key of ALL_LINE_KEYS) lines[key] = Number(input?.[key]) || 0;
  return lines;
}

/** The form's starting values: what the server holds. */
export function reportToFormValues(report: AnnualReport): AnnualReportFormValues {
  const d = report.disclosures;
  return {
    sizeClass: report.sizeClass,
    current: { ...report.figures.current },
    hasPrior: report.figures.prior !== null,
    prior: { ...(report.figures.prior ?? emptyLines()) },
    disclosures: {
      legalForm: d.legalForm ?? '',
      kvkNumber: d.kvkNumber ?? '',
      registeredOffice: d.registeredOffice ?? '',
      city: d.city ?? '',
      postalCode: d.postalCode ?? '',
      email: d.email ?? '',
      preparedOn: d.preparedOn ?? '',
      appropriation: d.appropriation,
      averageEmployees: d.averageEmployees ?? undefined,
    },
    adopted: report.adopted,
    adoptionDate: report.adoptionDate?.slice(0, 10) ?? '',
    notes: report.notes ?? '',
  };
}

const orNull = (value: string): string | null => value.trim() || null;

/** The PATCH body of a save: only the figures that changed, and the disclosures and adoption as typed. */
export function formValuesToPatch(values: AnnualReportFormValues, report: AnnualReport): AnnualReportPatch {
  const patch: AnnualReportPatch = {};
  if (values.sizeClass !== report.sizeClass) patch.sizeClass = values.sizeClass;

  const figures: NonNullable<AnnualReportPatch['figures']> = {};
  const current = changedLines(report.figures.current, normalizeLines(values.current));
  if (Object.keys(current).length > 0) figures.current = current;
  if (!values.hasPrior) {
    if (report.figures.prior !== null) figures.prior = null;
  } else {
    const prior = changedLines(report.figures.prior, normalizeLines(values.prior));
    if (Object.keys(prior).length > 0) figures.prior = prior;
  }
  if (figures.current || figures.prior !== undefined) patch.figures = figures;

  const d = values.disclosures;
  patch.disclosures = {
    legalForm: d.legalForm === '' ? null : d.legalForm,
    kvkNumber: orNull(d.kvkNumber),
    registeredOffice: orNull(d.registeredOffice),
    city: orNull(d.city),
    postalCode: orNull(d.postalCode),
    email: orNull(d.email),
    preparedOn: orNull(d.preparedOn),
    appropriation: d.appropriation,
    averageEmployees: d.averageEmployees ?? null,
  };
  patch.adopted = values.adopted;
  patch.adoptionDate = orNull(values.adoptionDate);
  patch.notes = orNull(values.notes);
  return patch;
}

/** Only a draft or a rejected report is edited; the form is read-only otherwise. */
export function isReportLocked(report: Pick<AnnualReport, 'status'>): boolean {
  return !isAnnualReportEditable(report.status);
}
