import { z } from 'zod';
import type { CsvFormat } from './types';

const columnRef = z.union([z.string().min(1).max(100), z.number().int().min(0).max(200)]);

/** The explicit CSV layout the import endpoints and `bank_accounts.import_settings` accept. */
export const csvFormatSchema = z
  .object({
    dateFormat: z.enum(['MDY', 'DMY', 'YMD']),
    decimalSeparator: z.enum(['.', ',']),
    thousandsSeparator: z.enum([',', '.', ' ', '']),
    negativeStyle: z.enum(['minus', 'parentheses', 'debit_credit_columns', 'trailing_minus']),
    columns: z.object({
      date: columnRef,
      description: columnRef,
      amount: columnRef.optional(),
      debit: columnRef.optional(),
      credit: columnRef.optional(),
      checkNumber: columnRef.optional(),
      payee: columnRef.optional(),
      reference: columnRef.optional(),
    }),
    hasHeader: z.boolean(),
    skipRows: z.number().int().min(0).max(100),
    delimiter: z.enum([',', ';', '\t', '|']).optional(),
  })
  .refine((f) => f.columns.amount !== undefined || f.columns.debit !== undefined || f.columns.credit !== undefined, {
    message: 'Pick an amount column, or a debit and a credit column',
    path: ['columns', 'amount'],
  })
  .refine((f) => f.decimalSeparator !== f.thousandsSeparator, {
    message: 'The decimal and thousands separators must differ',
    path: ['thousandsSeparator'],
  }) satisfies z.ZodType<CsvFormat, z.ZodTypeDef, unknown>;
