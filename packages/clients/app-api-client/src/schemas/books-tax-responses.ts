/**
 * Response shapes of books-api's VAT, GST and Brazil area (WeldBooks): the
 * Dutch BTW-aangifte and Opgaaf ICP, India's GST worksheet, Brazil's
 * apuração, and the fiscal documents issued and received through Focus NFe.
 *
 * The platform reads these through TypeScript interfaces
 * (`apps/web/platform/lib/api/domains/weldbooks*.ts`); these Zod schemas
 * mirror them so the Rust backend's answers are checked against the same
 * shapes (`packages/core/worker-kit/src/testing/conformance-schemas-books-tax.ts`).
 * Rows are `.passthrough()`: the routes answer whole rows, and the schemas
 * pin the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();

/** The BTW boxes (`VatRubrieken`). */
export const vatRubriekenSchema = z
  .object({
    r1a: z.number(),
    r1aBtw: z.number(),
    r1b: z.number(),
    r1bBtw: z.number(),
    r1c: z.number(),
    r1cBtw: z.number(),
    r1d: z.number(),
    r1dBtw: z.number(),
    r1e: z.number(),
    r2a: z.number(),
    r2aBtw: z.number(),
    r3a: z.number(),
    r3b: z.number(),
    r3c: z.number(),
    r4a: z.number(),
    r4aBtw: z.number(),
    r4b: z.number(),
    r4bBtw: z.number(),
    r5a: z.number(),
    r5b: z.number(),
    r5c: z.number(),
    r5d: z.number(),
    r5e: z.number(),
    r5f: z.number(),
    r5g: z.number(),
  })
  .passthrough();

/** A `vat_returns` row, its rubrieken in the current layout. */
export const vatReturnSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    periodType: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    periodLabel: nullableString,
    status: z.string(),
    rubrieken: vatRubriekenSchema.nullable(),
    filingReference: nullableString,
    filedAt: nullableString,
    correctionOfId: nullableString,
    suppletieDeadline: nullableString,
    notes: nullableString,
    createdAt: z.string(),
  })
  .passthrough();

/** `POST /api/vat-returns/calculate`. */
export const vatReturnCalculatedSchema = z.object({
  id: z.string(),
  rubrieken: vatRubriekenSchema,
  recalculated: z.boolean(),
});

/** `POST /api/vat-returns/:id/file`. */
export const vatReturnFiledSchema = z.object({
  id: z.string(),
  status: z.literal('filed'),
  kenmerk: z.string().optional(),
  digipoortSuccess: z.boolean(),
  message: z.string(),
});

/** `POST /api/vat-returns/:id/suppletie`. */
export const vatSuppletieSchema = z
  .object({
    correctionRequired: z.boolean(),
    netDiff: z.number(),
    message: z.string(),
    foldIntoNextReturn: z.boolean().optional(),
    id: z.string().optional(),
    recalculated: vatRubriekenSchema.optional(),
    suppletieDeadline: z.string().optional(),
  })
  .strict();

/** `GET /api/vat-returns/:id/filing-status`. */
export const vatFilingStatusSchema = z
  .object({
    id: z.string(),
    kenmerk: z.string(),
    success: z.boolean(),
    status: z.enum(['submitted', 'processing', 'accepted', 'rejected', 'unknown']),
    statusDescription: z.string().optional(),
    timestamp: z.string().optional(),
    simulated: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const gstHeadsSchema = z.object({ igst: z.number(), cgst: z.number(), sgst: z.number(), cess: z.number() });
const gstOutwardSchema = gstHeadsSchema.extend({ taxableValue: z.number() });

/** `GET /api/vat-returns/gst-worksheet` (`GstWorksheet`). */
export const gstWorksheetSchema = z
  .object({
    periodStart: z.string(),
    periodEnd: z.string(),
    entityStateCode: nullableString,
    gstr1: z
      .object({
        b2b: z.array(z.object({ gstin: z.string(), name: z.string(), lines: z.array(z.record(z.unknown())) }).passthrough()),
        b2cLarge: z.array(z.record(z.unknown())),
        b2cSmall: z.array(z.record(z.unknown())),
        exports: z.array(z.record(z.unknown())),
        nilExempt: z.array(z.record(z.unknown())),
        creditNotes: z.array(z.record(z.unknown())),
        hsn: z.array(z.record(z.unknown())),
        totals: gstOutwardSchema,
      })
      .passthrough(),
    gstr3b: z
      .object({
        outwardTaxable: gstOutwardSchema,
        zeroRated: gstOutwardSchema,
        nilExempt: z.object({ taxableValue: z.number() }),
        reverseCharge: gstOutwardSchema,
        interStateUnregistered: z.array(z.record(z.unknown())),
        itc: z.object({ other: gstHeadsSchema, reverseCharge: gstHeadsSchema, total: gstHeadsSchema }),
        payment: z
          .object({
            liability: gstHeadsSchema,
            reverseChargeLiability: gstHeadsSchema,
            netPayable: gstHeadsSchema,
            totalNetPayable: z.number(),
          })
          .passthrough(),
      })
      .passthrough(),
    unsplitTax: z.number(),
    warnings: z.array(z.object({ code: z.string(), count: z.number(), amount: z.number().optional() })),
  })
  .passthrough();

/** An `icp_declarations` row. */
export const icpDeclarationSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    periodType: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    periodLabel: nullableString,
    status: z.string(),
    totalAmount: z.string(),
    notes: nullableString,
    createdAt: z.string(),
  })
  .passthrough();

/** An `icp_lines` row. */
export const icpLineSchema = z
  .object({
    id: z.string(),
    declarationId: z.string(),
    vatNumber: z.string(),
    countryCode: z.string(),
    supplyType: z.string(),
    amount: z.string(),
  })
  .passthrough();

export const icpDeclarationDetailSchema = icpDeclarationSchema.extend({ lines: z.array(icpLineSchema) });

/** `POST /api/icp-declarations/calculate`. */
export const icpCalculatedSchema = z.object({
  id: z.string(),
  totalAmount: z.number(),
  lineCount: z.number(),
  skippedContacts: z.array(z.string()),
  recalculated: z.boolean(),
});

/** `POST /api/icp-declarations/:id/file`. */
export const icpFiledSchema = z.object({
  id: z.string(),
  status: z.literal('filed'),
  kenmerk: z.string().optional(),
  digipoortSuccess: z.boolean(),
  simulated: z.boolean(),
});

/** `GET /api/br-tax/apuracao` (`BrApuracao` and whether the month is booked). */
export const brApuracaoSchema = z
  .object({
    period: z.string(),
    regime: z.string(),
    simples: z.record(z.unknown()).nullable(),
    mei: z.record(z.unknown()).nullable(),
    taxes: z.array(
      z.object({
        code: z.string(),
        debits: z.number(),
        credits: z.number(),
        offsets: z.number(),
        payable: z.number(),
        dueDate: nullableString,
      }),
    ),
    withholdingsToPay: z.array(z.record(z.unknown())),
    withheldByCustomers: z.record(z.number()),
    quarterly: z.record(z.unknown()).nullable(),
    informational: z.object({ cbs: z.number(), ibs: z.number() }),
    total: z.number(),
    warnings: z.array(z.string()),
    status: z.enum(['open', 'booked']),
    taxReturnId: z.string().optional(),
    journalEntryId: z.string().optional(),
  })
  .passthrough();

/** `POST /api/br-tax/apuracao/book`. */
export const brApuracaoBookedSchema = z.object({ taxReturnId: z.string(), journalEntryId: nullableString });

/** `GET /api/br-tax/withholdings/suggest` (`BrWithholdingConfig`). */
export const brWithholdingSuggestionSchema = z
  .object({
    iss: z.number().nullable().optional(),
    irrf: z.number().nullable().optional(),
    csrf: z.boolean().nullable().optional(),
    inss: z.number().nullable().optional(),
  })
  .strict();

/** A `fiscal_documents` row. */
export const fiscalDocumentSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    sourceType: z.string(),
    sourceId: z.string(),
    kind: z.string(),
    provider: z.string(),
    providerRef: z.string(),
    environment: z.string(),
    status: z.string(),
    statusMessage: nullableString,
    number: nullableString,
    series: nullableString,
    accessKey: nullableString,
    authorizedAt: nullableString,
    cancelledAt: nullableString,
    xmlUrl: nullableString,
    pdfUrl: nullableString,
    createdAt: z.string(),
  })
  .passthrough();

/** `POST /api/fiscal-documents/:id/correction`. */
export const fiscalCorrectionSchema = z.object({
  document: fiscalDocumentSchema,
  correction: z.object({
    status: z.string(),
    number: z.number().nullable(),
    xmlUrl: nullableString,
    pdfUrl: nullableString,
    message: nullableString,
  }),
});

/** `GET`/`PUT /api/fiscal-documents/settings`. */
export const fiscalSettingsSchema = z
  .object({
    entityId: z.string(),
    provider: z.literal('focus_nfe'),
    environment: z.enum(['homologacao', 'producao']),
    environments: z.array(z.string()),
    hasCredentials: z.boolean(),
    credentialEnvironments: z.array(z.string()),
    credentialsReadable: z.boolean(),
    nfseStandard: z.string(),
    dpsSeries: z.number().nullable(),
    simplesCreditRate: z.number().nullable(),
    codigoTributarioMunicipio: nullableString,
    webhook: z.object({
      registered: z.boolean(),
      events: z.array(z.string()),
      supportedEvents: z.array(z.string()),
      registeredAt: nullableString,
    }),
    providerUrl: z.string(),
    webhookUrl: nullableString.optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

/** A received NF-e in a list (`receivedSummary`: no XML, no parsed items). */
export const receivedFiscalDocumentSummarySchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    kind: z.string(),
    accessKey: z.string(),
    issuerTaxId: nullableString,
    issuerName: nullableString,
    number: nullableString,
    series: nullableString,
    issueDate: nullableString,
    total: nullableString,
    status: z.string(),
    manifestation: nullableString,
    source: z.string(),
    billId: nullableString,
    hasXml: z.boolean(),
    summary: z.record(z.unknown()).nullable(),
  })
  .passthrough();

/** A received NF-e with its XML and parsed note. */
export const receivedFiscalDocumentSchema = receivedFiscalDocumentSummarySchema
  .omit({ hasXml: true, summary: true })
  .extend({ xml: nullableString, parsed: z.record(z.unknown()).nullable() });

/** `POST /api/received-fiscal-documents/sync`. */
export const receivedSyncSchema = z.object({
  fetched: z.number(),
  created: z.number(),
  updated: z.number(),
  xmlFetched: z.number(),
  hasMore: z.boolean(),
  version: z.number(),
});

/** `POST /api/received-fiscal-documents/:id/create-bill`. */
export const receivedBillCreatedSchema = z.object({
  bill: z
    .object({
      id: z.string(),
      billNumber: z.string(),
      status: z.literal('draft'),
      contactId: z.string(),
      total: z.string(),
      items: z.array(z.record(z.unknown())),
    })
    .passthrough(),
  document: receivedFiscalDocumentSummarySchema,
  warnings: z.array(z.string()),
});
