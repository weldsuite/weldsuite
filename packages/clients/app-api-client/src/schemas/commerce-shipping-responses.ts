/**
 * Response shapes of commerce-api's shipping routes: the plain CRUD rows
 * (carriers, return reasons and rules, pickups, returns, shipments, shipping
 * rules and prices, parcels) and the parcel module's payloads (analytics,
 * notification templates and webhooks, rates, settings, wallet).
 *
 * The platform reads these through its own TypeScript types; these Zod
 * schemas mirror what the routes answer so the Rust backend's answers are
 * checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-commerce-shipping.ts`).
 *
 * Table rows are `.passthrough()`: the routes answer whole rows, and the
 * schemas pin their main fields with exact types and nullability (numeric
 * columns arrive as strings, timestamps as ISO strings). Payloads a route
 * builds itself are `.strict()`: a key the route leaves out (`undefined`)
 * is optional.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const nullableInt = z.number().int().nullable();
const nullableBoolean = z.boolean().nullable();
/** A Drizzle `numeric` column: a decimal string. */
const numericText = z.string().nullable();
/** A JavaScript number that may have been NaN or Infinity, which JSON writes as null. */
const jsNumber = z.number().nullable();
const stringList = z.array(z.string()).nullable();
/**
 * A `jsonb` column a passthrough body can set to anything. Drizzle also
 * `JSON.parse`s a stored JSON string on read when it parses, so a column
 * written as `"19.99"` reads back as the number.
 */
const jsonValue = z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(z.unknown()), z.record(z.unknown())]);

const timestamps = {
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: nullableString,
};

/** `{ id }`: what a create or an update answers. */
export const shippingIdResultSchema = z.object({ id: z.string() }).strict();

/** `{ message }`: what the parcel settings writes answer. */
export const shippingMessageSchema = z.object({ message: z.string() }).strict();

// ── CRUD rows ───────────────────────────────────────────────────────────────

export const carrierRowSchema = z
  .object({
    id: z.string(),
    ...timestamps,
    name: z.string(),
    code: z.string(),
    logo: nullableString,
    website: nullableString,
    isActive: nullableBoolean,
    isDefault: nullableBoolean,
    integrationType: z.string(),
    apiCredentials: jsonValue,
    supportedServices: jsonValue,
    supportedCountries: jsonValue,
    features: jsonValue,
    trackingUrlTemplate: nullableString,
    supportEmail: nullableString,
    supportPhone: nullableString,
    accountNumber: nullableString,
    settings: jsonValue,
    description: nullableString,
  })
  .passthrough();

export const returnReasonRowSchema = z
  .object({
    id: z.string(),
    ...timestamps,
    code: z.string(),
    label: z.string(),
    description: nullableString,
    groupId: nullableString,
    displayOrder: nullableInt,
    isActive: nullableBoolean,
    requiresPhotos: nullableBoolean,
    requiresDetails: nullableBoolean,
    autoApprove: nullableBoolean,
    refundEligible: nullableBoolean,
    exchangeEligible: nullableBoolean,
    restockingFee: numericText,
    usageCount: nullableInt,
    translations: jsonValue,
  })
  .passthrough();

/** Return rules and shipping rules share their columns (shipping rules have no return window). */
const ruleColumns = {
  id: z.string(),
  ...timestamps,
  name: z.string(),
  description: nullableString,
  isActive: nullableBoolean,
  priority: nullableInt,
  conditions: jsonValue,
  conditionLogic: nullableString,
  actions: jsonValue,
  usageCount: nullableInt,
  lastUsedAt: nullableString,
};

export const returnRuleRowSchema = z.object({ ...ruleColumns, returnWindowDays: nullableInt }).passthrough();

export const shippingRuleRowSchema = z.object(ruleColumns).passthrough();

export const pickupRowSchema = z
  .object({
    id: z.string(),
    ...timestamps,
    pickupNumber: z.string(),
    status: z.string(),
    carrierId: z.string(),
    carrierName: nullableString,
    confirmationNumber: nullableString,
    pickupDate: z.string(),
    timeWindow: jsonValue,
    pickupAddress: jsonValue,
    contactName: nullableString,
    contactPhone: nullableString,
    specialInstructions: nullableString,
    shipmentIds: jsonValue,
    totalParcels: nullableInt,
    totalWeight: numericText,
    pickupCost: jsonValue,
    confirmedAt: nullableString,
    cancelledAt: nullableString,
    cancellationReason: nullableString,
  })
  .passthrough();

export const returnRowSchema = z
  .object({
    id: z.string(),
    ...timestamps,
    returnNumber: z.string(),
    status: z.string(),
    originalOrderId: nullableString,
    originalTrackingNumber: nullableString,
    customerId: nullableString,
    customerName: nullableString,
    customerEmail: nullableString,
    customerPhone: nullableString,
    reason: nullableString,
    reasonDetails: nullableString,
    condition: nullableString,
    items: jsonValue,
    returnParcelId: nullableString,
    returnTrackingNumber: nullableString,
    returnLabelUrl: nullableString,
    returnCarrier: nullableString,
    returnMethod: nullableString,
    receivedAt: nullableString,
    inspectedAt: nullableString,
    processedAt: nullableString,
    resolution: jsonValue,
    refundAmount: jsonValue,
    replacementOrderId: nullableString,
    customerNotes: nullableString,
    internalNotes: nullableString,
    approvalStatus: nullableString,
    approvedBy: nullableString,
    approvedAt: nullableString,
  })
  .passthrough();

export const shipmentRowSchema = z
  .object({
    id: z.string(),
    ...timestamps,
    shipmentNumber: z.string(),
    status: z.string(),
    type: z.string(),
    parcelIds: jsonValue,
    totalParcels: nullableInt,
    carrierId: nullableString,
    carrierName: nullableString,
    serviceType: nullableString,
    totalWeight: numericText,
    totalCost: jsonValue,
    shippedAt: nullableString,
    deliveredAt: nullableString,
    pickupId: nullableString,
    pickupDate: nullableString,
    pickupTimeWindow: jsonValue,
    manifestUrl: nullableString,
    bolUrl: nullableString,
    specialInstructions: nullableString,
    internalNotes: nullableString,
  })
  .passthrough();

export const shippingPriceRowSchema = z
  .object({
    id: z.string(),
    ...timestamps,
    name: z.string(),
    carrierId: nullableString,
    serviceType: nullableString,
    fromZone: nullableString,
    toZone: nullableString,
    weightRanges: jsonValue,
    flatRate: jsonValue,
    percentageMarkup: numericText,
    handlingFee: jsonValue,
    fuelSurcharge: numericText,
    currency: nullableString,
    effectiveFrom: nullableString,
    effectiveTo: nullableString,
    isActive: nullableBoolean,
    description: nullableString,
  })
  .passthrough();

export const parcelRowSchema = z
  .object({
    id: z.string(),
    ...timestamps,
    trackingNumber: nullableString,
    referenceNumber: nullableString,
    barcode: nullableString,
    status: z.string(),
    statusHistory: jsonValue,
    shipmentId: nullableString,
    orderId: nullableString,
    orderNumber: nullableString,
    returnId: nullableString,
    senderName: nullableString,
    senderAddress: jsonValue,
    recipientName: nullableString,
    recipientEmail: nullableString,
    recipientAddress: jsonValue,
    weight: numericText,
    weightUnit: nullableString,
    dimensions: jsonValue,
    packageType: nullableString,
    value: jsonValue,
    carrierId: nullableString,
    carrierName: nullableString,
    serviceType: nullableString,
    shippingCost: jsonValue,
    signatureRequired: nullableBoolean,
    saturdayDelivery: nullableBoolean,
    shippedAt: nullableString,
    estimatedDeliveryDate: nullableString,
    actualDeliveryDate: nullableString,
    labelUrl: nullableString,
    labelFormat: nullableString,
    customsInfo: jsonValue,
    isReturn: nullableBoolean,
    tags: jsonValue,
    notes: nullableString,
    customFields: jsonValue,
  })
  .passthrough();

// ── parcel analytics ────────────────────────────────────────────────────────

const count = z.number().int();

/** `GET /api/parcel-analytics`. */
export const parcelAnalyticsOverviewSchema = z
  .object({
    overview: z
      .object({
        totalParcels: count,
        totalShipments: count,
        totalDelivered: count,
        totalInTransit: count,
        totalPending: count,
        totalReturns: count,
        averageDeliveryTime: z.number(),
      })
      .strict(),
    costs: z.object({ totalShippingCost: z.number(), averageShippingCost: z.number(), currency: z.string() }).strict(),
    carriers: z.array(
      z
        .object({
          carrierId: z.string(),
          carrierName: z.string(),
          parcelCount: count,
          deliveredCount: count,
          averageDeliveryTime: z.number(),
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          parcelsCreated: z.number(),
          parcelsDelivered: z.number(),
          totalCost: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

/** `GET /api/parcel-analytics/carrier/:carrierId`. */
export const parcelCarrierPerformanceSchema = z
  .object({
    carrierId: z.string(),
    totalParcels: count,
    deliveredCount: count,
    failedCount: count,
    deliveryRate: z.number(),
    averageDeliveryTime: z.number(),
    totalCost: z.number(),
  })
  .strict();

// ── parcel notifications ────────────────────────────────────────────────────

/** The templates' and webhooks' offset paging, after `parseInt`: NaN and Infinity arrive as null. */
const offsetPaginationSchema = z
  .object({
    page: jsNumber,
    pageSize: jsNumber,
    totalCount: count,
    totalPages: jsNumber,
    hasMore: z.boolean(),
  })
  .strict();

/** A template row as the routes answer it: an unset `lastUsedAt` is left out. */
const templateColumns = {
  id: z.string(),
  ...timestamps,
  name: z.string(),
  variables: stringList,
  triggerEvent: nullableString,
  isActive: nullableBoolean,
  isDefault: nullableBoolean,
  usageCount: nullableInt,
  lastUsedAt: z.string().optional(),
  description: nullableString,
  tags: stringList,
};

export const parcelEmailTemplateSchema = z
  .object({ ...templateColumns, subject: z.string(), body: nullableString, htmlBody: nullableString })
  .passthrough();

export const parcelSmsTemplateSchema = z
  .object({ ...templateColumns, message: z.string(), maxLength: nullableInt })
  .passthrough();

export const parcelWhatsAppTemplateSchema = z
  .object({
    ...templateColumns,
    message: z.string(),
    headerText: nullableString,
    footerText: nullableString,
    mediaType: nullableString,
    mediaUrl: nullableString,
    buttons: z.array(z.record(z.unknown())).nullable(),
    approvalStatus: nullableString,
  })
  .passthrough();

/** `GET /api/parcel-notifications/{email,sms,whatsapp}`. */
const templatePage = <T extends z.ZodTypeAny>(template: T) =>
  z.object({ templates: z.array(template), pagination: offsetPaginationSchema }).strict();

export const parcelEmailTemplatePageSchema = templatePage(parcelEmailTemplateSchema);
export const parcelSmsTemplatePageSchema = templatePage(parcelSmsTemplateSchema);
export const parcelWhatsAppTemplatePageSchema = templatePage(parcelWhatsAppTemplateSchema);

/** `PATCH /api/parcel-notifications/{email,sms,whatsapp}/:id/toggle`. */
export const parcelTemplateToggleSchema = z.object({ id: z.string(), isActive: z.boolean() }).strict();

const webhookCounters = {
  totalDeliveries: count,
  totalFailures: count,
  consecutiveFailures: count,
  lastDeliveredAt: z.string().optional(),
  lastFailedAt: z.string().optional(),
};

/** One webhook of `GET /api/parcel-notifications/webhooks`. */
export const parcelWebhookListItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: nullableString,
    url: z.string(),
    events: z.array(z.string()),
    status: z.string(),
    isActive: z.boolean(),
    callCount: count,
    ...webhookCounters,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const parcelWebhookPageSchema = z
  .object({ webhooks: z.array(parcelWebhookListItemSchema), pagination: offsetPaginationSchema })
  .strict();

/** `GET /api/parcel-notifications/webhooks/:id`. */
export const parcelWebhookSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: nullableString,
    url: z.string(),
    events: z.array(z.string()),
    status: z.string(),
    isActive: z.boolean(),
    headers: z.record(z.string()).nullable(),
    ...webhookCounters,
    lastFailureReason: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** `POST /api/parcel-notifications/webhooks`: the signing secret, sent or drawn. */
export const parcelWebhookCreatedSchema = z.object({ id: z.string(), secret: z.string() }).strict();

/** `PATCH /api/parcel-notifications/webhooks/:id/{enable,disable}`. */
export const parcelWebhookStatusSchema = z.object({ id: z.string(), status: z.enum(['active', 'paused']) }).strict();

/** `POST /api/parcel-notifications/webhooks/:id/test`: delivered, answered non-2xx, or unreachable. */
export const parcelWebhookTestResultSchema = z.union([
  z.object({ delivered: z.literal(true), status: count, responseTimeMs: z.number() }).strict(),
  z.object({ delivered: z.literal(false), status: count, error: z.string() }).strict(),
  z.object({ delivered: z.literal(false), error: z.string() }).strict(),
]);

/** `GET /api/parcel-notifications/webhooks/:id/logs`. */
export const parcelWebhookLogsSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          eventType: z.string(),
          eventId: z.string(),
          status: z.string(),
          responseStatus: nullableInt,
          responseTimeMs: nullableInt,
          errorMessage: nullableString,
          attemptNumber: count,
          createdAt: z.string(),
          deliveredAt: z.string().optional(),
        })
        .strict(),
    ),
    meta: z.object({ page: jsNumber, limit: jsNumber, total: count, totalPages: jsNumber }).strict(),
  })
  .strict();

// ── parcel rates ────────────────────────────────────────────────────────────

/** One rate of `POST /api/parcel-rates/calculate`. */
export const parcelRateSchema = z
  .object({
    id: z.string(),
    carrier: z.string(),
    service: z.string(),
    amount: z.number(),
    currency: z.string(),
    estimatedDeliveryDays: z.number().optional(),
  })
  .strict();

/** `POST /api/parcel-rates/select`: no `carrier` when the price has none. */
export const parcelRateSelectionSchema = z
  .object({
    parcelId: z.string(),
    rateId: z.string(),
    carrier: z.string().optional(),
    service: nullableString,
  })
  .strict();

/** One carrier of `GET /api/parcel-rates/carriers`. */
export const parcelRateCarrierSchema = z
  .object({ id: z.string(), name: z.string(), code: z.string(), logo: nullableString })
  .strict();

// ── parcel settings ─────────────────────────────────────────────────────────

/** `GET /api/parcel-settings`: what was saved over the defaults; unset carrier and service left out. */
export const parcelSettingsSchema = z
  .object({
    defaultCarrier: z.string().optional(),
    defaultServiceType: z.string().optional(),
    autoGenerateLabels: z.boolean(),
    autoSendNotifications: z.boolean(),
    labelFormat: z.string(),
    labelSize: z.string(),
    defaultWeight: z.object({ value: z.number(), unit: z.string() }).strict(),
    defaultDimensions: z
      .object({ length: z.number(), width: z.number(), height: z.number(), unit: z.string() })
      .strict(),
  })
  .strict();

/** One carrier of `GET /api/parcel-settings/carriers`. */
export const parcelCarrierCredentialStatusSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    isActive: nullableBoolean,
    integrationType: z.string(),
    hasApiCredentials: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

// ── parcel wallet ───────────────────────────────────────────────────────────

const money = z.object({ amount: z.number(), currency: z.string() }).strict();

/** `GET /api/parcel-wallet`: unset limits and last transaction left out. */
export const parcelWalletSchema = z
  .object({
    id: z.string(),
    balance: money,
    creditLimit: z.number().optional(),
    lowBalanceThreshold: z.number().optional(),
    isActive: z.boolean(),
    isFrozen: z.boolean(),
    totalCredits: z.number(),
    totalDebits: z.number(),
    transactionCount: count,
    lastTransactionAt: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();

const transactionReferences = {
  balanceBefore: z.number().optional(),
  balanceAfter: z.number().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string(),
};

/** `GET /api/parcel-wallet/with-transactions`: no wallet yet is `{ wallet: null, transactions: [] }`. */
export const parcelWalletWithTransactionsSchema = z
  .object({
    wallet: z
      .object({
        id: z.string(),
        balance: money,
        isActive: z.boolean(),
        isFrozen: z.boolean(),
        totalCredits: z.number(),
        totalDebits: z.number(),
        transactionCount: count,
      })
      .strict()
      .nullable(),
    transactions: z.array(
      z.object({ id: z.string(), type: z.string(), amount: money, ...transactionReferences }).strict(),
    ),
  })
  .strict();

/** `GET /api/parcel-wallet/transactions`. */
export const parcelWalletTransactionPageSchema = z
  .object({
    transactions: z.array(
      z
        .object({ id: z.string(), type: z.string(), amount: z.number(), currency: z.string(), ...transactionReferences })
        .strict(),
    ),
    pagination: z
      .object({ page: count, pageSize: count, totalCount: count, totalPages: count, hasMore: z.boolean() })
      .strict(),
  })
  .strict();

/** `POST /api/parcel-wallet/credits` and `/deduct`. */
export const parcelWalletTransactionResultSchema = z
  .object({ newBalance: z.number(), transactionId: z.string() })
  .strict();

/** `POST /api/parcel-wallet/check-balance`. */
export const parcelWalletBalanceCheckSchema = z
  .object({
    hasSufficientBalance: z.boolean(),
    currentBalance: z.number(),
    required: z.number(),
    shortfall: z.number(),
  })
  .strict();

/** `POST /api/parcel-wallet/estimate-cost`. */
export const parcelCostEstimateSchema = z
  .object({
    estimatedCost: z.number(),
    currency: z.string(),
    breakdown: z.object({ basePrice: z.number(), weightCharge: z.number() }).strict(),
  })
  .strict();
