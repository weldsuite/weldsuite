/**
 * Response shapes of books-api's US sales tax area (WeldBooks): engine
 * settings and the calculation preview, agencies, jurisdictions and their
 * rates, taxability rules, zones, exemption certificates and the tax
 * calendar.
 *
 * The platform reads these through TypeScript interfaces
 * (`apps/web/platform/lib/api/domains/weldbooks-sales-tax.ts` and the US
 * screens); these Zod schemas mirror them so the Rust backend's answers are
 * checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-books-sales-tax.ts`).
 * Rows are `.passthrough()`: the routes answer whole rows, and the schemas pin
 * the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

const accountSummarySchema = z.object({ id: z.string(), code: nullableString, name: nullableString, balance: z.string() }).passthrough();

/** A `sales_tax_agencies` row with its payable accounts. */
export const salesTaxAgencySchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    stateCode: z.string(),
    level: z.string(),
    name: z.string(),
    status: z.string(),
    filingFrequency: z.string(),
    dueDay: z.number(),
    reportingBasis: z.string(),
    registeredFrom: nullableString,
    registeredUntil: nullableString,
    liabilityAccountId: nullableString,
    useTaxAccountId: nullableString,
    liabilityAccount: accountSummarySchema.nullable(),
    useTaxAccount: accountSummarySchema.nullable(),
    hasTaxLines: z.boolean().optional(),
    accountsCreated: z.number().optional(),
    rulesSeeded: z.number().optional(),
  })
  .passthrough();

/** DELETE of an agency that carries tax-ledger rows: closed, not deleted. */
export const salesTaxAgencyClosedSchema = z.object({
  id: z.string(),
  deleted: z.literal(false),
  closed: z.literal(true),
  status: z.literal('closed'),
  registeredUntil: z.string(),
});

/** A `sales_tax_jurisdiction_rates` row. */
export const salesTaxRateSchema = z
  .object({ id: z.string(), jurisdictionId: z.string(), rate: z.string(), effectiveFrom: z.string(), effectiveTo: nullableString })
  .passthrough();

/** A jurisdiction with its rates and the rate in force today. */
export const salesTaxJurisdictionSchema = z
  .object({
    id: z.string(),
    agencyId: z.string(),
    stateCode: z.string(),
    level: z.string(),
    name: z.string(),
    code: nullableString,
    reportingCode: nullableString,
    isActive: z.boolean(),
    currentRate: nullableNumber,
    rates: z.array(salesTaxRateSchema),
  })
  .passthrough();

/** A `sales_tax_taxability_rules` row. */
export const salesTaxRuleSchema = z
  .object({
    id: z.string(),
    agencyId: z.string(),
    taxCode: z.string(),
    taxable: z.boolean(),
    taxablePercent: z.string(),
    appliesToUse: z.string(),
    rateOverride: nullableString,
    effectiveFrom: z.string(),
    effectiveTo: nullableString,
  })
  .passthrough();

/** A zone with its jurisdictions and the combined rate in force today. */
export const salesTaxZoneSchema = z
  .object({
    id: z.string(),
    agencyId: z.string(),
    stateCode: z.string(),
    name: z.string(),
    jurisdictionIds: z.array(z.string()),
    postalCodes: z.array(z.union([z.string(), z.object({ from: z.string(), to: z.string() })])).nullable(),
    isOrigin: z.boolean(),
    priority: z.number(),
    jurisdictions: z.array(z.object({ id: z.string(), name: z.string(), level: z.string(), currentRate: nullableNumber }).passthrough()),
    combinedRate: z.number(),
  })
  .passthrough();

/** An exemption certificate with its status worked out for today. */
export const exemptionCertificateSchema = z
  .object({
    id: z.string(),
    partyId: z.string(),
    states: z.array(z.string()),
    reason: z.string(),
    form: z.string(),
    blanket: z.boolean(),
    status: z.string(),
    storedStatus: z.string(),
    expiryByState: z.record(nullableString),
    expiredStates: z.array(z.string()),
    effectiveExpiresOn: nullableString,
    daysUntilExpiry: nullableNumber,
    lastUsedOn: nullableString,
    linkedSales: z.number().optional(),
  })
  .passthrough();

/** GET/PUT /api/sales-tax/settings. */
export const salesTaxSettingsSchema = z
  .object({
    entityId: z.string(),
    engine: z.enum(['manual', 'stripe_tax', 'avalara']),
    config: z.object({ companyCode: nullableString, environment: z.string() }),
    hasCredentials: z.boolean(),
    engineOptions: z.array(z.object({ id: z.string(), credentialFields: z.array(z.string()), configFields: z.array(z.string()) })),
    agencies: z.array(z.object({ id: z.string(), stateCode: z.string(), name: z.string(), status: z.string() }).passthrough()),
    registeredStates: z.array(z.string()),
  })
  .passthrough();

/** POST /api/sales-tax/registration-check. */
export const salesTaxRegistrationCheckSchema = z.object({
  engine: z.string(),
  matched: z.array(z.object({ agencyId: z.string(), stateCode: z.string(), name: z.string(), providerRef: nullableString })),
  missingInProvider: z.array(z.object({ agencyId: z.string(), stateCode: z.string(), name: z.string() })),
  missingInWeldBooks: z.array(z.object({ stateCode: z.string(), providerRef: z.string() })),
  inSync: z.boolean(),
});

/** POST /api/sales-tax/validate-address. */
export const salesTaxAddressValidationSchema = z
  .object({ engine: z.string(), valid: z.boolean(), normalized: z.record(z.string()).optional(), messages: z.array(z.string()).optional() })
  .passthrough();

/** POST /api/sales-tax/calculate: the totals a draft will carry. */
export const salesTaxCalculationSchema = z
  .object({
    engine: nullableString,
    engineRef: nullableString,
    calculatedAt: z.string(),
    warnings: z.array(z.string()),
    shipToState: nullableString,
    shipToPostalCode: nullableString,
    addressIncomplete: z.boolean(),
    subtotal: z.string(),
    discountTotal: z.string(),
    taxTotal: z.string(),
    total: z.string(),
    lines: z.array(
      z
        .object({
          index: z.number(),
          id: z.string(),
          lineTotal: z.string(),
          taxAmount: z.string(),
          lineTotalWithTax: z.string(),
          taxRate: nullableString,
          taxRateId: nullableString,
          taxCode: nullableString,
        })
        .passthrough(),
    ),
    jurisdictions: z.array(
      z.object({ jurisdictionName: z.string().nullable(), level: z.string(), rate: z.number(), taxableAmount: z.number(), taxAmount: z.number(), kind: z.string() }).passthrough(),
    ),
    taxBreakdown: z.array(z.object({ taxRateName: z.string(), taxRate: z.number(), taxableAmount: z.number(), taxAmount: z.number() }).passthrough()),
    placeOfSupply: nullableString,
  })
  .passthrough();

/** GET /api/tax-calendar. */
export const taxCalendarSchema = z
  .object({
    supported: z.boolean(),
    year: z.number(),
    today: z.string(),
    form: nullableString,
    facts: z
      .object({ hasPayroll: z.boolean(), files1099: z.boolean(), hasBackupWithholding: z.boolean(), agencies: z.number() })
      .nullable(),
    items: z.array(
      z
        .object({
          key: z.string(),
          kind: z.string(),
          title: z.string(),
          dueDate: z.string(),
          nominalDate: z.string(),
          form: z.string(),
          completed: z.boolean(),
          completedAt: nullableString,
          completionSource: z.enum(['manual', 'return']).nullable(),
          returnId: nullableString,
          daysUntilDue: z.number(),
          overdue: z.boolean(),
        })
        .passthrough(),
    ),
    message: z.string().optional(),
  })
  .passthrough();

/** POST /api/tax-calendar/complete. */
export const taxCalendarCompletionSchema = z.object({
  id: z.string(),
  deadlineKey: z.string(),
  dueDate: z.string(),
  completedBy: nullableString,
  completedAt: z.string(),
  notes: nullableString,
});
