/**
 * Response shapes of books-api's reports and US compliance area (WeldBooks):
 * the accounting reports (JSON and the print document; CSV and the XAF export
 * are files), the dashboard, payroll imports and connections, and fixed
 * assets with their depreciation reports.
 *
 * The platform reads these through TypeScript interfaces
 * (`apps/web/platform/lib/weldbooks/report-types.ts`,
 * `apps/web/platform/lib/api/domains/weldbooks{,-assets}.ts`); these Zod
 * schemas mirror them so the Rust backend's answers are checked against the
 * same shapes (`packages/core/worker-kit/src/testing/conformance-schemas-books-reports.ts`).
 * Rows and reports are `.passthrough()`: the routes answer whole rows and
 * report objects, and the schemas pin the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const money = z.string();
const dateRangeSchema = z.object({ from: z.string(), to: z.string() }).passthrough();
const reportColumnSchema = z.object({ key: z.string(), label: z.string(), from: nullableString, to: z.string() }).passthrough();
const deltaSchema = z.object({ amount: money, percent: z.number().nullable() });
const valueSetSchema = z.object({ values: z.record(z.string()), delta: deltaSchema.optional() }).passthrough();

// ---------------------------------------------------------------------------
// Accounting reports

/** `?format=print`: the print document every report can answer with. */
export const reportPrintDocumentSchema = z
  .object({
    kind: z.literal('report'),
    report: z.string(),
    title: z.string(),
    paper: z.enum(['letter', 'a4']),
    entity: z.object({ name: z.string(), jurisdictionCode: z.string() }).passthrough(),
    basis: z.enum(['accrual', 'cash']).nullable(),
    periodLabel: z.string(),
    currency: z.string(),
    generatedAt: z.string(),
    table: z
      .object({
        report: z.string(),
        title: z.string(),
        hasCode: z.boolean(),
        columns: z.array(z.object({ key: z.string(), label: z.string(), numeric: z.boolean() })),
        rows: z.array(
          z
            .object({
              kind: z.enum(['section', 'account', 'subtotal', 'total', 'note']),
              depth: z.number(),
              label: z.string(),
              values: z.record(z.union([z.string(), z.number(), z.null()])),
            })
            .passthrough(),
        ),
        notes: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

/** A report as JSON, or its print document. */
function report<T extends z.ZodTypeAny>(json: T) {
  return z.union([json, reportPrintDocumentSchema]);
}

const reportAccountRowSchema = valueSetSchema.extend({
  accountId: nullableString,
  accountCode: z.string(),
  accountName: z.string(),
  accountType: z.string(),
  normalSide: z.enum(['debit', 'credit']),
  totalDebit: money,
  totalCredit: money,
  balance: money,
});

export const profitLossReportSchema = report(
  z
    .object({
      basis: z.enum(['accrual', 'cash']),
      period: dateRangeSchema,
      columns: z.array(reportColumnSchema),
      revenue: z.array(reportAccountRowSchema),
      expenses: z.array(reportAccountRowSchema),
      totalRevenue: money,
      totalExpenses: money,
      netProfit: money,
      totals: z.record(valueSetSchema),
    })
    .passthrough(),
);

export const balanceSheetReportSchema = report(
  z
    .object({
      basis: z.enum(['accrual', 'cash']),
      asOf: z.string(),
      columns: z.array(reportColumnSchema),
      assets: z.array(reportAccountRowSchema),
      liabilities: z.array(reportAccountRowSchema),
      equity: z.array(reportAccountRowSchema),
      totalAssets: money,
      totalLiabilities: money,
      totalEquity: money,
      isBalanced: z.boolean(),
      totals: z.record(valueSetSchema),
    })
    .passthrough(),
);

export const trialBalanceReportSchema = report(
  z
    .object({
      basis: z.enum(['accrual', 'cash']),
      period: dateRangeSchema,
      columns: z.array(reportColumnSchema),
      accounts: z.array(
        valueSetSchema.extend({
          accountId: z.string(),
          accountCode: z.string(),
          accountName: z.string(),
          debitBalance: money,
          creditBalance: money,
        }),
      ),
      totalDebit: money,
      totalCredit: money,
      isBalanced: z.boolean(),
    })
    .passthrough(),
);

const agingBuckets = ['current', '1-30', '31-60', '61-90', '90+'] as const;

export const agedReportSchema = report(
  z
    .object({
      asOf: z.string(),
      buckets: z.record(z.union([money, z.object({ total: money, count: z.number() })])),
      total: money,
      contacts: z.array(z.object({ contactId: z.string(), contactName: nullableString, total: money }).passthrough()),
      documents: z.array(
        z
          .object({
            id: z.string(),
            number: nullableString,
            dueDate: z.string(),
            daysPastDue: z.number(),
            bucket: z.enum(agingBuckets),
            balance: money,
          })
          .passthrough(),
      ),
    })
    .passthrough(),
);

export const taxSummaryReportSchema = report(
  z.object({ period: dateRangeSchema, breakdown: z.array(z.object({ taxRateId: nullableString, totalTax: z.string() }).passthrough()) }).passthrough(),
);

export const generalLedgerReportSchema = report(
  z
    .object({
      basis: z.enum(['accrual', 'cash']),
      account: z.object({ id: z.string(), code: z.string(), name: z.string() }).passthrough(),
      period: dateRangeSchema,
      openingBalance: money,
      closingBalance: money,
      lines: z.array(
        z.object({ id: z.string(), entryDate: z.string(), debit: money, credit: money, runningBalance: money }).passthrough(),
      ),
      pagination: z.object({ page: z.number(), pageSize: z.number(), totalCount: z.number(), hasMore: z.boolean() }).passthrough(),
    })
    .passthrough(),
);

const cashTotalsSchema = z.object({ inflows: money, outflows: money, net: money }).passthrough();

export const cashFlowReportSchema = report(
  z
    .object({
      period: dateRangeSchema,
      openingBalance: money,
      closingBalance: money,
      monthly: z.array(cashTotalsSchema.extend({ month: z.string() })),
      totals: cashTotalsSchema,
      activities: z.array(cashTotalsSchema.extend({ activity: z.string(), categories: z.array(cashTotalsSchema) })),
      cashAccounts: z.array(z.object({ accountId: z.string(), openingBalance: money, closingBalance: money }).passthrough()),
    })
    .passthrough(),
);

/** Revenue by customer and expense by category: rows with a total, on the basis of the report. */
export const breakdownReportSchema = report(
  z.object({ basis: z.enum(['accrual', 'cash']), period: dateRangeSchema }).passthrough(),
);

export const taxWorksheetSchema = report(
  z
    .object({
      form: z.string(),
      taxYear: z.number(),
      basis: z.enum(['accrual', 'cash']),
      period: dateRangeSchema,
      entity: z.object({ id: z.string(), name: z.string() }).passthrough(),
      sections: z.array(z.object({ key: z.string(), label: z.string(), lines: z.array(z.object({ code: z.string(), amount: money }).passthrough()) }).passthrough()),
      unmapped: z.array(z.object({ accountId: z.string(), amount: money }).passthrough()),
      summary: z.object({ netIncomePerBooks: money, reconciles: z.boolean() }).passthrough(),
    })
    .passthrough(),
);

// ---------------------------------------------------------------------------
// Dashboard

const agingSchema = z.record(z.object({ total: money, count: z.number() }));

export const accountingDashboardSchema = z
  .object({
    currency: z.string().optional(),
    revenue: z.object({ month: money, year: money, invoiceCount: z.number() }),
    expenses: z.object({ month: money, year: money }),
    profit: z.object({ month: money, year: money }),
    receivables: z.object({ outstanding: money, outstandingCount: z.number(), overdue: money, overdueCount: z.number(), aging: agingSchema.optional() }).passthrough(),
    payables: z.object({ outstanding: money, outstandingCount: z.number(), aging: agingSchema.optional() }).passthrough(),
    bankAccounts: z.array(z.object({ id: z.string(), name: z.string(), iban: nullableString, currentBalance: nullableString, currency: nullableString })),
    recentPayments: z.array(z.object({ id: z.string() }).passthrough()),
    upcomingDue: z.array(z.object({ id: z.string(), invoiceNumber: nullableString, contactName: nullableString, dueDate: z.string(), balanceDue: nullableString })),
    pendingDocuments: z.number(),
    monthlyRevenue: z.array(z.object({ month: z.string(), total: money })),
    monthlyTrend: z.array(z.object({ month: z.string(), revenue: money, expenses: money, profit: money })).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Payroll

export const payrollCategorySchema = z.object({ key: z.string(), label: z.string(), side: z.enum(['debit', 'credit']) }).passthrough();

/** The entity's saved CSV mapping, or null. */
export const payrollCsvMappingSchema = z.object({ shape: z.enum(['summary', 'gl']) }).passthrough().nullable();

/** A `payroll_imports` row. */
export const payrollImportSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    source: z.string(),
    status: z.string(),
    payDate: z.string(),
    journalEntryId: nullableString,
  })
  .passthrough();

export const payrollImportDetailSchema = payrollImportSchema.extend({
  lines: z.array(z.object({ accountId: z.string(), debit: money, credit: money }).passthrough()),
});

export const payrollCsvImportResultSchema = z
  .object({
    shape: z.enum(['summary', 'gl']),
    dryRun: z.boolean(),
    imports: z.array(
      z
        .object({
          importId: nullableString,
          payDate: z.string(),
          journalEntryId: nullableString,
          totalDebit: z.number(),
          lines: z.array(z.object({ accountId: z.string(), debit: z.number(), credit: z.number() }).passthrough()),
        })
        .passthrough(),
    ),
    duplicates: z.array(z.object({ payDate: z.string(), importId: z.string(), status: z.string() })),
    failed: z.array(z.object({ payDate: z.string(), error: z.string() })),
  })
  .passthrough();

/** A payroll connection without its credentials. */
export const payrollConnectionSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    provider: z.string(),
    status: z.string(),
    hasCredentials: z.boolean(),
    environment: z.enum(['production', 'demo']).nullable(),
  })
  .passthrough()
  .refine((row) => !('credentialsEncrypted' in row), 'credentials leaked');

export const payrollSyncResultSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    fetched: z.number(),
    imported: z.array(z.object({ externalId: z.string(), payDate: z.string(), importId: z.string(), journalEntryId: z.string() })),
    skipped: z.array(z.object({ externalId: nullableString, payDate: nullableString, reason: z.string() })),
    failed: z.array(z.object({ externalId: z.string(), payDate: z.string(), error: z.string() })),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Fixed assets

const issueSchema = z.object({ severity: z.enum(['error', 'warning']), code: z.string(), message: z.string() });
const bookIssueSchema = issueSchema.extend({ book: z.string(), stateCode: nullableString });

const depreciationBasisSchema = z.object({
  cost: z.number(),
  businessUsePercent: z.number(),
  baseCost: z.number(),
  salvage: z.number(),
  section179: z.number(),
  bonus: z.number(),
  depreciableBasis: z.number(),
  totalDepreciable: z.number(),
});

const depreciationRowSchema = z.object({
  label: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  amount: z.number(),
  regular: z.number(),
  section179: z.number(),
  bonus: z.number(),
  accumulated: z.number(),
  remaining: z.number(),
});

/** A `fixed_assets` row. */
export const fixedAssetSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    assetNumber: nullableString,
    name: z.string(),
    assetClass: nullableString,
    assetAccountId: z.string(),
    accumulatedDepreciationAccountId: z.string(),
    depreciationExpenseAccountId: z.string(),
    acquisitionDate: z.string(),
    placedInServiceDate: z.string(),
    cost: money,
    salvageValue: money,
    businessUsePercent: z.string(),
    status: z.string(),
    disposalDate: nullableString,
    disposalProceeds: nullableString,
    disposalJournalEntryId: nullableString,
    classId: nullableString,
    locationId: nullableString,
  })
  .passthrough();

/** A `fixed_asset_books` row. */
export const fixedAssetBookSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    book: z.enum(['book', 'federal', 'state']),
    stateCode: nullableString,
    method: z.string(),
    convention: z.string(),
    recoveryYears: z.string(),
    section179Amount: money,
    bonusPercent: z.string(),
    depreciableBasis: money,
    postsToLedger: z.boolean(),
  })
  .passthrough();

export const fixedAssetListItemSchema = fixedAssetSchema.extend({
  books: z.array(
    z.object({
      id: z.string(),
      book: z.string(),
      stateCode: nullableString,
      method: z.string(),
      convention: z.string(),
      recoveryYears: z.string(),
      postsToLedger: z.boolean(),
    }),
  ),
  accumulatedPosted: money,
  netBookValuePosted: money,
});

const scheduleViewSchema = z.object({
  method: z.string(),
  convention: z.string(),
  recoveryYears: z.number(),
  basis: depreciationBasisSchema,
  annual: z.array(depreciationRowSchema),
  issues: z.array(issueSchema),
});

/** A `fixed_asset_depreciation` row: one month (or 4-4-5 period) of the ledger book. */
const ledgerDepreciationRowSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    bookId: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    amount: money,
    accumulated: money,
    journalEntryId: nullableString,
  })
  .passthrough();

export const fixedAssetDetailSchema = fixedAssetSchema.extend({
  books: z.array(fixedAssetBookSchema.and(z.object({ schedule: scheduleViewSchema }))),
  ledgerRows: z.array(ledgerDepreciationRowSchema),
  accumulatedPosted: money,
  netBookValuePosted: money,
  issues: z.array(bookIssueSchema),
});

export const fixedAssetWriteResultSchema = fixedAssetSchema.extend({
  books: z.array(fixedAssetBookSchema),
  issues: z.array(bookIssueSchema),
});

export const fixedAssetFromBillLineSchema = fixedAssetWriteResultSchema.extend({
  source: z.object({
    billId: z.string(),
    billItemId: z.string(),
    lineAccountId: nullableString,
    lineAccountCode: nullableString,
    capitalized: z.boolean(),
    reclassNeeded: z.boolean(),
    reclassJournalEntryId: nullableString,
  }),
});

export const fixedAssetScheduleSchema = z.object({
  assetId: z.string(),
  schedules: z.array(
    scheduleViewSchema.omit({ recoveryYears: true }).extend({
      bookId: z.string(),
      book: z.string(),
      stateCode: nullableString,
      recoveryYears: z.number(),
      postsToLedger: z.boolean(),
      monthly: z
        .array(z.object({ periodStart: z.string(), periodEnd: z.string(), amount: money, accumulated: money, journalEntryId: nullableString }))
        .optional(),
    }),
  ),
});

const postedPeriodSchema = z.object({
  periodEnd: z.string(),
  journalEntryId: z.string(),
  entryNumber: nullableString,
  amount: z.number(),
  assets: z.number(),
  alreadyPosted: z.boolean(),
});

export const depreciationRunSchema = z.object({
  through: z.string(),
  posted: z.array(postedPeriodSchema),
  skipped: z.array(z.object({ periodEnd: z.string(), assets: z.number(), amount: z.number(), reason: z.string() })),
  fullyDepreciatedAssetIds: z.array(z.string()),
  totalPosted: z.number(),
});

export const fixedAssetDisposalSchema = z.object({
  asset: fixedAssetSchema,
  journalEntryId: z.string(),
  entryNumber: nullableString,
  proceeds: z.number(),
  accumulatedDepreciation: z.number(),
  netBookValue: z.number(),
  gainOrLoss: z.number(),
  result: z.enum(['gain', 'loss', 'none']),
  catchUp: z.array(postedPeriodSchema),
  disposalMonthDepreciation: z.number(),
  taxBooks: z.array(
    z.object({
      book: z.string(),
      stateCode: nullableString,
      method: z.string(),
      accumulated: z.number(),
      proceeds: z.number(),
      adjustedBasis: z.number(),
      gainOrLoss: z.number(),
      result: z.enum(['gain', 'loss', 'none']),
      ordinaryRecapture: z.number(),
      unrecapturedSection1250: z.number(),
      remainingGain: z.number(),
    }),
  ),
});

export const fixedAssetRegisterSchema = z.object({
  asOf: z.string(),
  book: z.enum(['book', 'federal', 'state']),
  stateCode: nullableString,
  accumulatedThrough: z.enum(['month_end', 'fiscal_year_end']),
  lines: z.array(
    z.object({
      assetId: z.string(),
      assetNumber: nullableString,
      name: z.string(),
      assetClass: nullableString,
      status: z.string(),
      placedInServiceDate: z.string(),
      disposalDate: nullableString,
      disposed: z.boolean(),
      cost: z.number(),
      method: z.string(),
      convention: z.string(),
      recoveryYears: z.number(),
      accumulatedDepreciation: z.number(),
      netBookValue: z.number(),
      accumulatedPosted: z.number().optional(),
    }),
  ),
  totals: z.object({ cost: z.number(), accumulatedDepreciation: z.number(), netBookValue: z.number(), accumulatedPosted: z.number().optional() }),
});

export const midQuarterTestSchema = z.object({
  applies: z.boolean(),
  totalBasis: z.number(),
  lastQuarterBasis: z.number(),
  lastQuarterShare: z.number(),
  quarterBasis: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  taxYear: z.number(),
  start: z.string(),
  end: z.string(),
  threshold: z.number(),
  assets: z.array(
    z.object({
      assetId: z.string(),
      assetNumber: nullableString,
      name: z.string(),
      placedInServiceDate: z.string(),
      quarter: z.number(),
      basis: z.number(),
      counted: z.boolean(),
      excludedReason: z.enum(['real_property', 'disposed_in_same_year']).nullable(),
      convention: z.string(),
    }),
  ),
});

export const taxDepreciationReportSchema = z.object({
  taxYear: z.number(),
  start: z.string(),
  end: z.string(),
  book: z.enum(['federal', 'state']),
  stateCode: nullableString,
  lines: z.array(
    z
      .object({
        assetId: z.string(),
        name: z.string(),
        placedInServiceThisYear: z.boolean(),
        method: z.string(),
        convention: z.string(),
        recoveryYears: z.number(),
        depreciableBasis: z.number(),
        section179: z.number(),
        bonus: z.number(),
        macrs: z.number(),
        total: z.number(),
        accumulated: z.number(),
        listedProperty: z.boolean(),
        issues: z.array(z.string()),
      })
      .passthrough(),
  ),
  form4562: z.object({
    part1: z.object({
      totalCostOfSection179Property: z.number(),
      limit: z.number().nullable(),
      phaseOutThreshold: z.number().nullable(),
      reduction: z.number(),
      dollarLimit: z.number().nullable(),
      elected: z.number(),
      deduction: z.number(),
    }),
    part2: z.object({ bonus: z.number() }),
    part3: z.object({
      priorYearAssets: z.number(),
      currentYearAssets: z.array(
        z.object({ recoveryYears: z.number(), convention: z.string(), method: z.string(), count: z.number(), basis: z.number(), depreciation: z.number() }),
      ),
      currentYearTotal: z.number(),
    }),
    listedProperty: z.array(z.object({ assetId: z.string(), name: z.string(), businessUsePercent: z.number(), total: z.number() })),
    total: z.number(),
  }),
  midQuarter: midQuarterTestSchema,
});

export const deMinimisCheckSchema = z.object({
  amount: z.number(),
  date: z.string(),
  hasAfs: z.boolean(),
  threshold: z.number().nullable(),
  applies: z.boolean(),
  advice: z.enum(['expense', 'capitalize']),
  explanation: z.string(),
});

// ---------------------------------------------------------------------------
// Form 1099

const boxAmountsSchema = z.record(z.number());

/** A vendor row of the yearly 1099 review: the last four of the TIN only. */
export const form1099VendorRowSchema = z
  .object({
    partyId: z.string(),
    name: z.string(),
    legalName: z.string(),
    status: z.enum(['included', 'below_threshold', 'excluded_corporation', 'needs_tin', 'needs_address', 'not_1099_vendor']),
    reasons: z.array(z.string()),
    forms: z.array(z.enum(['nec', 'misc'])),
    boxes: boxAmountsSchema,
    totals: boxAmountsSchema,
    aboveThreshold: z.boolean(),
    isCorporation: z.boolean(),
    tinLast4: nullableString,
    tinMasked: nullableString,
    hasTin: z.boolean(),
    backupWithholding: z.boolean(),
    suggestBackupWithholding: z.boolean(),
    addressComplete: z.boolean(),
    excluded: z.object({ cardOrNetwork: z.number(), creditCardAccount: z.number(), payroll: z.number(), omittedBox: z.number() }),
    unmappedAmount: z.number(),
    paymentCount: z.number(),
    bankTransactionCount: z.number(),
  })
  .passthrough();

const form1099DeadlinesSchema = z
  .object({
    taxYear: z.number(),
    nec: z.object({ recipient: z.string(), irs: z.string() }),
    misc: z.object({ recipient: z.string(), recipientBoxes8And10: z.string(), irsPaper: z.string(), irsElectronic: z.string() }),
    form945: z.string(),
  })
  .passthrough();

export const form1099SummarySchema = z.object({
  taxYear: z.number(),
  entityId: z.string(),
  thresholds: z.object({
    published: z.boolean(),
    general: z.number().nullable(),
    royalty: z.number().nullable(),
    fixed600: z.number().nullable(),
    boxes: z.record(z.number().nullable()),
  }),
  deadlines: form1099DeadlinesSchema,
  summary: z.record(z.number()),
  totals: z.object({ nec: z.number(), misc: z.number(), withheld: z.number() }),
  vendors: z.array(form1099VendorRowSchema),
  warnings: z.array(z.string()),
});

export const form1099VendorDetailSchema = z.object({
  taxYear: z.number(),
  vendor: form1099VendorRowSchema,
  contributions: z.array(z.object({ box: z.string(), amount: z.number(), boxSource: z.string(), unapplied: z.boolean() }).passthrough()),
  exclusions: z.array(z.object({ reason: z.string(), amount: z.number(), paymentMethod: nullableString }).passthrough()),
  unmapped: z.array(z.object({ reason: z.string(), amount: z.number() }).passthrough()),
  adjustments: z.array(z.object({ partyId: z.string(), box: z.string(), amount: z.number(), reason: z.string() }).passthrough()),
  warnings: z.array(z.string()),
});

export const form1099DeadlinesResponseSchema = form1099DeadlinesSchema.extend({
  eFile: z.object({ requiredFrom: z.number(), waiverRequestDays: z.number(), necWaiverDeadline: z.string(), miscWaiverDeadline: z.string() }),
});

export const form945SummarySchema = z.object({
  taxYear: z.number(),
  backupWithholding: z.number(),
  totalTaxes: z.number(),
  months: z.array(z.object({ month: z.number(), amount: z.number(), depositDue: z.string() })),
  byVendor: z.array(z.object({ partyId: z.string(), amount: z.number(), paymentIds: z.array(z.string()), name: nullableString })),
  dueDate: z.string(),
});

export const tinMatchingFileSchema = z.object({
  files: z.array(z.object({ filename: z.string(), content: z.string(), recordCount: z.number() })),
  recordCount: z.number(),
  skipped: z.array(z.object({ partyId: z.string(), reason: z.string(), name: nullableString })),
});

export const tinMatchingResultsSchema = z.object({
  updated: z.array(z.string()),
  byStatus: z.record(z.number()),
  problems: z.array(z.object({ partyId: z.string(), name: nullableString, status: z.string(), backupWithholding: z.boolean(), suggestion: z.string() })),
  stale: z.array(z.object({ partyId: z.string(), name: nullableString })),
  unknownAccounts: z.array(z.object({ line: z.number(), accountNumber: z.string() })),
  ignored: z.array(z.object({ line: z.number(), code: z.number(), reason: z.string() })),
  unreadable: z.array(z.object({ line: z.number(), text: z.string() })),
});

/** A `form_1099_filings` row with its totals. */
export const form1099FilingSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    taxYear: z.number(),
    formType: z.enum(['nec', 'misc']),
    status: z.enum(['draft', 'reviewed', 'generated', 'filed', 'corrected']),
    lineCount: z.number(),
    totals: z.object({ amount: z.number(), withheld: z.number() }),
    statusCounts: z.record(z.number()),
  })
  .passthrough();

/** A filing line as the API shows it: never the sealed TIN. */
const form1099LineSchema = z
  .object({
    id: z.string(),
    filingId: z.string(),
    partyId: z.string(),
    status: z.string(),
    boxes: boxAmountsSchema,
    hasTin: z.boolean(),
    partyName: nullableString,
    superseded: z.boolean(),
    pendingCorrection: z.boolean(),
    stateHint: z.object({ state: z.string(), direct: z.string(), needsDirectFiling: z.boolean() }).passthrough().nullable(),
  })
  .passthrough()
  .refine((line) => !('recipientTinEncrypted' in line), 'the sealed TIN left the API');

export const form1099FilingDetailSchema = z.object({ filing: form1099FilingSchema, lines: z.array(form1099LineSchema) }).passthrough();

export const irisFilesSchema = z.object({
  files: z.array(z.object({ filename: z.string(), content: z.string(), recordCount: z.number(), warnings: z.array(z.string()) })),
  taxYear: z.number(),
  formType: z.enum(['nec', 'misc']),
  correctionsOnly: z.boolean(),
});

export const form1099CopiesSchema = z.object({
  taxYear: z.number(),
  formType: z.enum(['nec', 'misc']),
  lineId: z.string(),
  recipientTin: z.string(),
  copies: z.array(
    z
      .object({
        form: z.enum(['nec', 'misc']),
        copy: z.enum(['B', '1', '2', 'C']),
        title: z.string(),
        fields: z.array(z.object({ id: z.string(), label: z.string(), value: z.string(), kind: z.string() }).passthrough()),
        blocks: z.array(z.object({ id: z.string(), paragraphs: z.array(z.string()) }).passthrough()),
        footer: z.string(),
      })
      .passthrough(),
  ),
  warnings: z.array(z.string()),
});
