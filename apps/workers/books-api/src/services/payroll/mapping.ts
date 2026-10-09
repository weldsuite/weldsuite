/**
 * Mappings for payroll imports.
 *
 * Account mapping: a payroll category (`gross_wages`, `net_pay`, ...) to an
 * account id of the entity. Used by the summary CSV shape and by Gusto.
 *
 * CSV mapping: which columns of an export mean what, plus the account mapping
 * (summary shape) or a map from the export's account labels to account ids (GL
 * shape). The entity's saved CSV mapping lives in the `accountMapping` of its
 * `csv` pseudo connection in `payroll_connections`, flattened into string
 * keys: `shape`, `dateFormat`, `col.<column>` and `acc.<category or label>`.
 */

import { z } from 'zod';

/** Categories of a payroll summary and what they post to. */
export const PAYROLL_CATEGORIES = {
  /** Debit. Falls back to the `payroll_wages_expense` account. */
  gross_wages: 'Gross wages',
  /** Debit; credited to payroll liabilities. Falls back to `payroll_tax_expense`. */
  employer_taxes: 'Employer payroll taxes',
  /** Debit (employer benefit contributions); credited to payroll liabilities. Falls back to the wages account. */
  employer_benefits: 'Employer benefits',
  /** Debit, paid with net pay. Falls back to `general_expense`. */
  reimbursements: 'Expense reimbursements',
  /** Debit, paid with net pay. Falls back to `owner_draws`. */
  owners_draw: "Owner's draw",
  /** Credit: taxes withheld from employees. Falls back to `payroll_liabilities`. */
  employee_taxes: 'Employee taxes withheld',
  /** Credit: benefit deductions, garnishments and other deductions. Falls back to `payroll_liabilities`. */
  employee_deductions: 'Employee deductions',
  /** Credit: the default for every liability above and for employer taxes and benefits. Falls back to `payroll_liabilities`. */
  payroll_liabilities: 'Payroll liabilities',
  /** Credit: the bank or payroll clearing account the pay went from. Required. */
  net_pay: 'Net pay (bank or payroll clearing)',
} as const;

export type PayrollCategory = keyof typeof PAYROLL_CATEGORIES;

export const accountMappingSchema = z.record(z.string().trim().min(1).max(30)).superRefine((mapping, ctx) => {
  for (const key of Object.keys(mapping)) {
    if (!(key in PAYROLL_CATEGORIES)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown payroll category '${key}'`, path: [key] });
    }
  }
});

const columnName = z.string().trim().min(1).max(100);
const dateFormat = z.enum(['auto', 'mdy', 'dmy', 'iso']).default('auto');

export const summaryColumnsSchema = z.object({
  payDate: columnName,
  grossWages: columnName,
  netPay: columnName,
  employerTaxes: columnName.optional(),
  employeeTaxes: columnName.optional(),
  employeeDeductions: columnName.optional(),
  employerBenefits: columnName.optional(),
  reimbursements: columnName.optional(),
  ownersDraw: columnName.optional(),
  periodStart: columnName.optional(),
  periodEnd: columnName.optional(),
  /** A column whose value tells two payrolls with the same date apart. */
  reference: columnName.optional(),
});

export const glColumnsSchema = z.object({
  date: columnName,
  account: columnName,
  debit: columnName,
  credit: columnName,
  memo: columnName.optional(),
});

export const csvMappingSchema = z.discriminatedUnion('shape', [
  z.object({
    shape: z.literal('summary'),
    columns: summaryColumnsSchema,
    accounts: accountMappingSchema,
    dateFormat,
  }),
  z.object({
    shape: z.literal('gl'),
    columns: glColumnsSchema,
    /** The export's account label (or number) to an account id. Labels not listed are matched to the chart by code or name. */
    accounts: z.record(z.string().trim().min(1).max(30)).default({}),
    dateFormat,
  }),
]);

export type CsvMapping = z.infer<typeof csvMappingSchema>;
export type AccountMapping = Record<string, string>;

/** The saved form of a CSV mapping: flat string keys, as `accountMapping` stores them. */
export function flattenCsvMapping(mapping: CsvMapping): Record<string, string> {
  const flat: Record<string, string> = { shape: mapping.shape, dateFormat: mapping.dateFormat };
  for (const [key, value] of Object.entries(mapping.columns)) {
    if (value) flat[`col.${key}`] = value;
  }
  for (const [key, value] of Object.entries(mapping.accounts)) flat[`acc.${key}`] = value;
  return flat;
}

/** The mapping a flat record holds, or null when it is not a valid one. */
export function expandCsvMapping(flat: Record<string, string> | null | undefined): CsvMapping | null {
  if (!flat?.shape) return null;
  const columns: Record<string, string> = {};
  const accounts: Record<string, string> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith('col.')) columns[key.slice(4)] = value;
    else if (key.startsWith('acc.')) accounts[key.slice(4)] = value;
  }
  const parsed = csvMappingSchema.safeParse({ shape: flat.shape, dateFormat: flat.dateFormat ?? 'auto', columns, accounts });
  return parsed.success ? parsed.data : null;
}
