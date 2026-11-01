/**
 * Response shapes of books-api's vendor payment runs (WeldBooks,
 * `/api/payment-runs`): runs, payable bills, check print data, the check
 * register, NACHA and Positive Pay files and a bank account's payment
 * settings.
 *
 * The platform reads these through TypeScript interfaces
 * (`apps/web/platform/lib/api/domains/weldbooks-payment-runs.ts`); these Zod
 * schemas mirror them so the Rust backend's answers are checked against the
 * same shapes (`packages/core/worker-kit/src/testing/conformance-schemas-books-purchases.ts`).
 * Objects are `.passthrough()`: the schemas pin the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const money = z.string();
const checkStatus = z.enum(['to_print', 'printed', 'cleared', 'voided']);
const runStatus = z.enum(['draft', 'pending_approval', 'approved', 'exported', 'completed', 'cancelled']);
const secCode = z.enum(['PPD', 'CCD', 'CCD+', 'CTX']);
const holdRelease = z.object({ by: z.string(), at: z.string(), reason: z.string() }).passthrough().nullable();

// ── payable bills ───────────────────────────────────────────────────────────

const payableBillSchema = z
  .object({
    id: z.string(),
    billNumber: nullableString,
    reference: nullableString,
    status: z.string(),
    issueDate: nullableString,
    dueDate: z.string(),
    daysOverdue: z.number().int().nonnegative(),
    currency: nullableString,
    total: nullableString,
    balanceDue: nullableString,
    inOpenRunId: nullableString,
  })
  .passthrough();

/** A vendor with approved bills to pay (`GET /payable-bills`). */
export const payableVendorSchema = z
  .object({
    partyId: z.string(),
    name: z.string(),
    addressLines: z.array(z.string()),
    totalDue: money,
    ach: z
      .object({
        hasRouting: z.boolean(),
        hasAccount: z.boolean(),
        hasAccountType: z.boolean(),
        routingValid: z.boolean(),
        last4: nullableString,
        accountType: nullableString,
        bankDetailsChangedAt: nullableString,
        bankDetailsVerifiedAt: nullableString,
        verified: z.boolean(),
        holdActive: z.boolean(),
        ready: z.boolean(),
        prenote: z.enum(['proven', 'pending', 'needed']),
        held: z.boolean(),
      })
      .passthrough()
      .nullable(),
    backupWithholding: z.union([
      z.object({ applies: z.literal(false) }).strict(),
      z
        .object({
          applies: z.literal(true),
          reason: z.enum(['no_tin', 'flagged']).nullable(),
          rate: z.number(),
          amount: money,
          net: money,
        })
        .strict(),
    ]),
    bills: z.array(payableBillSchema),
  })
  .passthrough();

// ── runs ────────────────────────────────────────────────────────────────────

/** A run in the list (`GET /`). */
export const paymentRunSummarySchema = z
  .object({
    id: z.string(),
    bankAccountId: z.string(),
    bankAccountName: nullableString,
    method: z.enum(['check', 'ach']),
    status: runStatus,
    paymentDate: z.string(),
    secCode: secCode.nullable(),
    sameDay: z.boolean(),
    totalAmount: money,
    paymentCount: z.number().int(),
    requiredApprovals: z.number().int(),
    approvalCount: z.number().int(),
    billCount: z.number().int(),
    heldVendorCount: z.number().int(),
    fileName: nullableString,
    fileGeneratedAt: nullableString,
    createdBy: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
    notes: nullableString,
  })
  .passthrough();

/** A run with its bills, vendors, holds, payments, approvals and history. */
export const paymentRunDetailSchema = paymentRunSummarySchema
  .extend({
    bankAccount: z.object({ id: z.string(), name: z.string(), accountNumberLast4: nullableString }).passthrough().nullable(),
    heldAmount: money,
    withheldAmount: money,
    netAmount: money,
    approvals: z.array(z.object({ userId: z.string(), at: z.string() }).passthrough()),
    items: z.array(
      z
        .object({
          billId: z.string(),
          billNumber: nullableString,
          partyId: z.string(),
          partyName: z.string(),
          amount: money,
          billTotal: nullableString,
          balanceDue: nullableString,
          dueDate: nullableString,
        })
        .passthrough(),
    ),
    vendors: z.array(
      z
        .object({
          partyId: z.string(),
          name: z.string(),
          amount: money,
          billCount: z.number().int(),
          held: z.boolean(),
          backupWithholding: z
            .object({ amount: money, net: money, reason: z.enum(['no_tin', 'flagged']).nullable(), rate: z.number() })
            .passthrough()
            .nullable(),
          holds: z.array(
            z
              .object({
                code: z.string(),
                message: z.string(),
                releasable: z.boolean(),
                released: holdRelease,
                blocker: nullableString,
              })
              .passthrough(),
          ),
          payment: z
            .object({
              id: z.string(),
              amount: money,
              backupWithholdingAmount: nullableString,
              netAmount: money,
              checkNumber: nullableString,
              checkStatus: nullableString,
              deleted: z.boolean(),
            })
            .passthrough()
            .nullable(),
        })
        .passthrough(),
    ),
    holds: z.array(
      z
        .object({
          partyId: z.string(),
          partyName: z.string(),
          code: z.string(),
          message: z.string(),
          released: holdRelease,
          releasable: z.boolean(),
        })
        .passthrough(),
    ),
    history: z.array(
      z
        .object({
          action: z.string(),
          userId: nullableString,
          at: z.string(),
          changes: z.record(z.unknown()).nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const runPaymentSchema = z
  .object({
    paymentId: z.string(),
    partyId: z.string(),
    partyName: z.string(),
    amount: money,
    backupWithholdingAmount: nullableString,
    netAmount: money,
    checkNumber: nullableString,
    created: z.boolean(),
  })
  .passthrough();

/** `POST /:id/approve`. */
export const approveRunResultSchema = z
  .object({
    run: paymentRunDetailSchema,
    approved: z.boolean(),
    approvalCount: z.number().int(),
    requiredApprovals: z.number().int(),
    payments: z.array(runPaymentSchema),
  })
  .passthrough();

// ── checks ──────────────────────────────────────────────────────────────────

const micrFieldsSchema = z.object({ auxOnUs: z.string(), transit: z.string(), onUs: z.string() }).strict();

/** `GET /:id/checks`: what the platform prints the checks from. */
export const checkPrintDataSchema = z
  .object({
    run: z.object({ id: z.string(), status: z.string(), paymentDate: z.string(), bankAccountId: z.string() }).passthrough(),
    layout: z
      .object({
        id: z.string(),
        label: z.string(),
        page: z.object({ width: z.number(), height: z.number() }).passthrough(),
        faces: z.array(z.object({ top: z.number(), height: z.number(), fields: z.record(z.unknown()) }).passthrough()),
        vouchers: z.array(z.object({ top: z.number(), height: z.number(), fields: z.record(z.unknown()) }).passthrough()),
      })
      .passthrough(),
    settings: z
      .object({ layout: z.string(), printMicr: z.boolean(), signatureLineText: nullableString, checkNumberWidth: z.number().int() })
      .passthrough(),
    payer: z.object({ name: z.string(), dba: nullableString, addressLines: z.array(z.string()) }).passthrough(),
    bank: z.object({ name: nullableString, addressLines: z.array(z.string()), accountNumberLast4: nullableString }).passthrough(),
    checks: z.array(
      z
        .object({
          paymentId: z.string(),
          checkNumber: z.string(),
          checkStatus,
          date: z.string(),
          dateDisplay: z.string(),
          amount: money,
          grossAmount: money,
          backupWithholdingAmount: nullableString,
          amountInWords: z.string(),
          courtesyAmount: z.string(),
          payee: z.object({ partyId: z.string(), name: z.string(), addressLines: z.array(z.string()) }).passthrough(),
          memo: nullableString,
          fractionalRouting: nullableString,
          micr: z.object({ line: z.string(), fields: micrFieldsSchema, fieldsAsFontLetters: micrFieldsSchema }).passthrough().nullable(),
          voucher: z
            .object({
              rows: z.array(
                z
                  .object({
                    date: nullableString,
                    reference: nullableString,
                    description: nullableString,
                    amount: money,
                    billTotal: nullableString,
                    discount: nullableString,
                  })
                  .passthrough(),
              ),
              grossTotal: money,
              backupWithholding: nullableString,
              total: money,
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** `POST /:id/checks/printed`. */
export const markPrintedResultSchema = z
  .object({ run: paymentRunDetailSchema, printed: z.array(z.string()), alreadyPrinted: z.array(z.string()) })
  .passthrough();

/** `POST /checks/:paymentId/void`. */
export const voidCheckResultSchema = z
  .object({
    voided: z
      .object({
        paymentId: z.string(),
        checkNumber: nullableString,
        amount: money,
        backupWithholdingAmount: nullableString,
        netAmount: money,
        partyId: z.string(),
        runId: nullableString,
      })
      .passthrough(),
    replacement: z
      .object({
        paymentId: z.string(),
        checkNumber: nullableString,
        amount: money,
        backupWithholdingAmount: nullableString,
        netAmount: money,
        checkStatus,
      })
      .passthrough()
      .nullable(),
    run: z.object({ id: z.string(), status: runStatus }).passthrough().nullable(),
  })
  .passthrough();

const checkRegisterRowSchema = z
  .object({
    paymentId: z.string(),
    checkNumber: nullableString,
    date: z.string(),
    payeeId: z.string(),
    payeeName: z.string(),
    amount: money,
    grossAmount: money,
    backupWithholdingAmount: nullableString,
    status: checkStatus,
    bankAccountId: nullableString,
    runId: nullableString,
    runStatus: nullableString,
    printedAt: nullableString,
    voidedAt: nullableString,
    reference: nullableString,
    notes: nullableString,
  })
  .passthrough();

/** `GET /check-register`: the rows, a summary by status and the pagination (no `success` envelope). */
export const checkRegisterPageSchema = z
  .object({
    data: z.array(checkRegisterRowSchema),
    summary: z.record(z.object({ count: z.number().int(), total: money }).passthrough()).optional(),
    pagination: z.object({ totalCount: z.number().int(), hasMore: z.boolean(), cursor: nullableString }).passthrough(),
  })
  .passthrough();

// ── files ───────────────────────────────────────────────────────────────────

/** `GET /:id/nacha`. */
export const nachaFileResultSchema = z
  .object({
    fileName: z.string(),
    content: z.string(),
    summary: z
      .object({
        runId: z.string(),
        fileName: z.string(),
        fileDate: z.string(),
        effectiveEntryDate: z.string(),
        fileIdModifier: z.string(),
        sameDay: z.boolean(),
        balanced: z.boolean(),
        paymentCount: z.number().int(),
        prenoteCount: z.number().int(),
        batchCount: z.number().int(),
        recordCount: z.number().int(),
        blockCount: z.number().int(),
        entryHash: z.string(),
        totalCredit: money,
        totalDebit: money,
        originator: z.record(z.string()),
        payments: z.array(
          z
            .object({
              paymentId: z.string(),
              partyId: z.string(),
              name: z.string(),
              amount: money,
              grossAmount: money,
              backupWithholdingAmount: nullableString,
              secCode,
              accountLast4: nullableString,
              traceNumber: nullableString,
            })
            .passthrough(),
        ),
        prenotes: z.array(z.object({ partyId: z.string(), name: z.string(), traceNumber: nullableString }).passthrough()),
        warnings: z.array(z.object({ code: z.string(), message: z.string(), paymentId: z.string().optional() }).passthrough()),
      })
      .passthrough(),
  })
  .passthrough();

/** A Positive Pay format (`GET /positive-pay/formats`). */
export const positivePayFormatSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(['csv', 'fixed']),
    documentation: z.enum(['generic', 'third_party', 'none']),
    needsBankSpec: z.boolean(),
    note: z.string(),
    sourceUrl: z.string().optional(),
  })
  .passthrough();

/** `GET /positive-pay`. */
export const positivePayFileSchema = z
  .object({
    fileName: z.string(),
    content: z.string(),
    format: z.string(),
    counts: z
      .object({ records: z.number().int(), issued: z.number().int(), voided: z.number().int(), totalIssued: money, totalVoided: money })
      .passthrough(),
    warnings: z.array(z.object({ code: z.string(), message: z.string(), checkNumber: z.string().optional() }).passthrough()),
  })
  .passthrough();

// ── settings ────────────────────────────────────────────────────────────────

const readinessSchema = z.object({ ready: z.boolean(), missing: z.array(z.string()) }).passthrough();

/** `GET|PUT /settings/:bankAccountId`. */
export const bankPaymentSettingsSchema = z
  .object({
    bankAccountId: z.string(),
    bankAccountName: z.string(),
    bankName: nullableString,
    routingNumber: nullableString,
    accountNumberLast4: nullableString,
    hasAccountNumber: z.boolean(),
    nextCheckNumber: z.number().int().nullable(),
    highestCheckNumberUsed: z.number().int().nullable(),
    checkSettings: z
      .object({
        layout: z.string(),
        alignment: z.record(z.number()),
        printMicr: z.boolean(),
        micrLayout: z.enum(['business', 'personal']),
        checkNumberWidth: z.number().int(),
        bankName: nullableString,
        bankAddressLines: z.array(z.string()),
        fractionalNumerator: nullableString,
        signatureLineText: nullableString,
      })
      .passthrough(),
    achSettings: z
      .object({
        immediateDestination: nullableString,
        immediateDestinationName: nullableString,
        immediateOrigin: nullableString,
        immediateOriginName: nullableString,
        companyName: nullableString,
        companyIdentification: nullableString,
        odfiRoutingNumber: nullableString,
        balanced: z.boolean(),
        offsetBankAccountId: nullableString,
        defaultSecCode: secCode,
        sameDayAllowed: z.boolean(),
        entryDescription: nullableString,
        holdWindowDays: z.number().int(),
        requirePrenotes: z.boolean(),
      })
      .passthrough(),
    effectiveAch: z
      .object({
        immediateDestination: nullableString,
        immediateDestinationName: z.string(),
        immediateOrigin: nullableString,
        immediateOriginName: z.string(),
        companyName: z.string(),
        companyIdentification: nullableString,
        odfiRoutingNumber: nullableString,
      })
      .passthrough(),
    positivePayFormat: z.string(),
    positivePayConfig: z.record(z.unknown()),
    readiness: z.object({ checks: readinessSchema, ach: readinessSchema, positivePay: readinessSchema }).passthrough(),
    layouts: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() }).passthrough()),
    positivePayFormats: z.array(positivePayFormatSchema),
  })
  .passthrough();
