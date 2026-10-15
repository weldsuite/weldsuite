/**
 * Request schemas for the Brazilian fiscal fields of invoices and bills
 * (NCM, CFOP, rate overrides per line; withholdings and the buyer's ICMS
 * status per document). The tax engine reads them from the line and document
 * `fiscal_data` columns; see BrLineFiscalData / BrDocumentFiscalData in
 * @weldsuite/books-domain/jurisdictions/br.
 */

import { z } from 'zod';

const percent = z.number().min(0).max(100);

export const ncmSchema = z.string().trim().regex(/^(\d{8})?$/, 'NCM must be 8 digits').nullable().optional();
export const cfopSchema = z.string().trim().regex(/^([1-7]\d{3})?$/, 'CFOP must be 4 digits').nullable().optional();

export const brLineFiscalSchema = z
  .object({
    cest: z.string().trim().regex(/^\d{7}$/, 'CEST must be 7 digits').optional(),
    origin: z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8']).optional(),
    icmsRate: percent.optional(),
    ipiRate: percent.optional(),
    issRate: z.number().min(0).max(5).optional(),
    serviceCode: z.string().trim().max(10).optional(),
    nbs: z.string().trim().max(12).optional(),
    ibsCbsCst: z.string().trim().max(3).optional(),
    cClassTrib: z.string().trim().max(6).optional(),
  })
  .strict()
  .nullable()
  .optional();

export const brWithholdingsSchema = z
  .object({
    iss: z.number().min(0).max(5).nullable().optional(),
    irrf: z.number().min(0).max(27.5).nullable().optional(),
    csrf: z.boolean().nullable().optional(),
    inss: z.number().min(0).max(20).nullable().optional(),
  })
  .strict();

export const brDocumentFiscalSchema = z
  .object({
    withholdings: brWithholdingsSchema.optional(),
    finalConsumer: z.boolean().optional(),
    buyerIcmsContributor: z.boolean().optional(),
    counterpartySimples: z.boolean().optional(),
    naturezaOperacao: z.string().trim().max(60).optional(),
    /** Bills: the supplier's NF-e access key. */
    accessKey: z.string().trim().regex(/^\d{44}$/, 'The access key has 44 digits').optional(),
  })
  .strict()
  .nullable()
  .optional();
