/**
 * Response shapes of commerce-api (WeldCommerce): products and their sales
 * channels, categories, orders and their sales tax, the Sendcloud and
 * PrintNode settings, and the B2B commerce portal (the buyers' public routes
 * and the staff routes).
 *
 * The platform reads these through its own TypeScript types; these Zod
 * schemas mirror what the routes answer so the Rust backend's answers are
 * checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-commerce.ts`).
 * Table rows are `.passthrough()`: the routes answer whole rows, and the
 * schemas pin the fields the clients read with their exact types and
 * nullability (numeric columns arrive as strings, timestamps as ISO strings).
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const nullableBoolean = z.boolean().nullable();
const nullableStrings = z.array(z.string()).nullable();
/** A jsonb column nothing validates on the way in. */
const nullableRecord = z.record(z.unknown()).nullable();

const timestamps = {
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: nullableString,
};

/** `{ id }`: what a create or an update answers. */
export const commerceIdResultSchema = z.object({ id: z.string() }).passthrough();

/** `{ ok: true }`: the portal's answers that reveal nothing. */
export const commerceOkSchema = z.object({ ok: z.literal(true) });

// ── products ────────────────────────────────────────────────────────────────

export const commerceProductRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    sku: nullableString,
    barcode: nullableString,
    description: nullableString,
    shortDescription: nullableString,
    price: z.string(),
    compareAtPrice: nullableString,
    costPrice: nullableString,
    currency: nullableString,
    trackInventory: nullableBoolean,
    inventoryQuantity: nullableNumber,
    lowStockThreshold: nullableNumber,
    allowBackorder: nullableBoolean,
    weight: nullableString,
    length: nullableString,
    width: nullableString,
    height: nullableString,
    status: z.string(),
    visibility: nullableString,
    images: z.array(z.record(z.unknown())).nullable(),
    featuredImageUrl: nullableString,
    productType: nullableString,
    vendor: nullableString,
    brand: nullableString,
    taxable: nullableBoolean,
    taxClass: nullableString,
    hasVariants: nullableBoolean,
    tags: nullableStrings,
    attributes: nullableRecord,
    customFields: nullableRecord,
    salesCount: nullableNumber,
    publishedAt: nullableString,
    ...timestamps,
  })
  .passthrough();

/** One listing of a product on an external store (`product_sales_channels`). */
export const productSalesChannelSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    connectionId: z.string(),
    provider: z.string(),
    displayName: nullableString,
    externalId: z.string(),
    externalUrl: nullableString,
    status: z.string(),
    price: nullableString,
    listingStatus: z.string(),
    lastSyncedAt: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** A product as the product routes answer it: the row and its listings. */
export const commerceProductSchema = commerceProductRowSchema.extend({
  salesChannels: z.array(productSalesChannelSchema),
});

/** A connection a product can be published to (`GET /api/products/sales-channel-targets`). */
export const salesChannelTargetSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  displayName: nullableString,
  status: z.string(),
  externalAccountId: nullableString,
});

/** A category a product was added to by hand (`GET /api/products/:id/categories`). */
export const productCategoryRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  parentId: nullableString,
  depth: nullableNumber,
  type: nullableString,
  isActive: nullableNumber,
});

// ── categories ──────────────────────────────────────────────────────────────

export const commerceCategoryRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: nullableString,
    parentId: nullableString,
    path: nullableString,
    depth: nullableNumber,
    position: nullableNumber,
    image: nullableString,
    icon: nullableString,
    color: nullableString,
    metaTitle: nullableString,
    metaDescription: nullableString,
    isActive: nullableNumber,
    publishedAt: nullableString,
    type: nullableString,
    rules: z
      .array(z.object({ column: z.string(), relation: z.string(), condition: z.string() }).passthrough())
      .nullable(),
    rulesMatch: nullableString,
    sortOrder: nullableString,
    productCount: nullableNumber,
    customFields: nullableRecord,
    ...timestamps,
  })
  .passthrough();

export interface CommerceCategoryTreeNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string | null;
  depth: number;
  position: number;
  type: string;
  isActive: boolean;
  children: CommerceCategoryTreeNode[];
}

/** A node of `GET /api/categories/tree`, its children nested. */
export const commerceCategoryTreeNodeSchema: z.ZodType<CommerceCategoryTreeNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    parentId: nullableString,
    path: nullableString,
    depth: z.number(),
    position: z.number(),
    type: z.string(),
    isActive: z.boolean(),
    children: z.array(commerceCategoryTreeNodeSchema),
  }),
);

export const categoryCreatedSchema = z.object({ id: z.string(), slug: z.string() });

export const categoryMembersPreviewSchema = z.object({
  products: z.array(commerceProductRowSchema),
  totalCount: z.number(),
});

export const categoryMembersAddedSchema = z.object({ added: z.number(), skipped: z.number() });

// ── orders ──────────────────────────────────────────────────────────────────

const orderTaxLineSchema = z.object({ title: z.string(), rate: z.number(), price: z.string() });

export const commerceOrderRowSchema = z
  .object({
    id: z.string(),
    orderNumber: z.string(),
    externalOrderId: nullableString,
    customerId: nullableString,
    customerEmail: nullableString,
    customerName: nullableString,
    customerPhone: nullableString,
    counterpartyId: nullableString,
    personId: nullableString,
    status: z.string(),
    paymentStatus: nullableString,
    fulfillmentStatus: nullableString,
    currency: nullableString,
    subtotal: z.string(),
    discountTotal: nullableString,
    shippingTotal: nullableString,
    taxTotal: nullableString,
    total: z.string(),
    taxLines: z.array(orderTaxLineSchema.passthrough()).nullable(),
    taxExempt: nullableNumber,
    billingAddress: nullableRecord,
    shippingAddress: nullableRecord,
    shippingMethod: nullableString,
    trackingNumber: nullableString,
    paidAt: nullableString,
    customerNote: nullableString,
    internalNote: nullableString,
    itemCount: nullableNumber,
    totalQuantity: nullableNumber,
    source: nullableString,
    metadata: nullableRecord,
    tags: nullableStrings,
    ...timestamps,
  })
  .passthrough();

export const commerceOrderItemRowSchema = z
  .object({
    id: z.string(),
    orderId: z.string(),
    createdAt: z.string(),
    productId: nullableString,
    variantId: nullableString,
    sku: nullableString,
    name: z.string(),
    description: nullableString,
    imageUrl: nullableString,
    quantity: z.number(),
    unitPrice: z.string(),
    discountAmount: nullableString,
    taxAmount: nullableString,
    total: z.string(),
    weight: nullableString,
    fulfilledQuantity: nullableNumber,
    requiresShipping: nullableNumber,
    properties: nullableRecord,
  })
  .passthrough();

/** An order with its line items (the portal's order detail and placed order). */
export const commerceOrderWithItemsSchema = commerceOrderRowSchema.extend({
  items: z.array(commerceOrderItemRowSchema),
});

const orderTaxJurisdictionSchema = z.object({
  code: z.string(),
  name: z.string(),
  level: z.enum(['state', 'county', 'city', 'district']),
  stateCode: z.string(),
  agencyId: z.string().optional(),
  rate: z.number(),
  taxableAmount: z.number(),
  tax: z.number(),
});

const orderTaxUnsupportedFields = {
  supported: z.literal(false),
  reason: z.enum(['no_accounting_entity', 'sales_tax_not_supported']),
  entityId: z.string().optional(),
};

const orderTaxCalculatedFields = {
  supported: z.literal(true),
  entityId: z.string(),
  engine: z.string(),
  engineRef: z.string().optional(),
  calculatedAt: z.string(),
  documentDate: z.string(),
  currency: z.string(),
  sourcing: z.enum(['origin', 'modified_origin', 'destination', 'none']),
  shipToState: z.string().optional(),
  shipToPostalCode: z.string().optional(),
  totalTax: z.number(),
  shippingTax: z.number(),
  /** Per line, without the per-jurisdiction `details` the stored order keeps. */
  lines: z.array(
    z.object({
      lineId: z.string(),
      taxCode: z.string(),
      tax: z.number(),
      rate: z.number(),
      taxableAmount: z.number(),
      exemptAmount: z.number(),
      nonTaxableAmount: z.number(),
    }),
  ),
  jurisdictions: z.array(orderTaxJurisdictionSchema),
  warnings: z.array(z.string()),
};

/** A sales tax calculation (`toTaxResponse`): unsupported, or the engine's result. */
export const orderTaxResultSchema = z.discriminatedUnion('supported', [
  z.object(orderTaxUnsupportedFields),
  z.object(orderTaxCalculatedFields),
]);

/** What an applied calculation wrote on the order. */
export const orderTaxAppliedOrderSchema = z.object({
  id: z.string(),
  taxLines: z.array(orderTaxLineSchema),
  taxTotal: z.string(),
  total: z.string(),
});

/** `POST /api/orders/:id/calculate-tax`: the calculation, applied or a preview. */
export const orderTaxRecalculationSchema = z.discriminatedUnion('supported', [
  z.object({ ...orderTaxUnsupportedFields, applied: z.boolean(), order: orderTaxAppliedOrderSchema.optional() }),
  z.object({ ...orderTaxCalculatedFields, applied: z.boolean(), order: orderTaxAppliedOrderSchema.optional() }),
]);

/** `POST /api/orders` and `PATCH /api/orders/:id`: the id, plus the tax when `calculateTax` asked for it. */
export const orderWriteResultSchema = z.object({
  id: z.string(),
  tax: orderTaxResultSchema.optional(),
  order: orderTaxAppliedOrderSchema.optional(),
});

// ── Sendcloud ───────────────────────────────────────────────────────────────

export const sendcloudSenderPublicSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    companyName: nullableString.optional(),
    contactName: nullableString.optional(),
    email: nullableString.optional(),
    phone: nullableString.optional(),
    addressLine1: nullableString.optional(),
    addressLine2: nullableString.optional(),
    houseNumber: nullableString.optional(),
    postalCode: nullableString.optional(),
    city: nullableString.optional(),
    countryCode: nullableString.optional(),
    enabled: z.boolean(),
    isDefault: z.boolean(),
  })
  .passthrough();

export const sendcloudMethodPublicSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    carrierCode: nullableString.optional(),
    carrierName: nullableString.optional(),
    minWeightKg: nullableNumber.optional(),
    maxWeightKg: nullableNumber.optional(),
    enabled: z.boolean(),
    isDefault: z.boolean(),
  })
  .passthrough();

/** The Sendcloud connection as the browser sees it: never the secret key. */
export const sendcloudSettingsPublicSchema = z
  .object({
    connected: z.boolean(),
    publicKeyMasked: nullableString,
    accountName: nullableString,
    lastSyncedAt: nullableString,
    senders: z.array(sendcloudSenderPublicSchema),
    methods: z.array(sendcloudMethodPublicSchema),
  })
  .strict();

// ── PrintNode ───────────────────────────────────────────────────────────────

/** The stored PrintNode config: free-form, `apiKey` the one field always written. */
export const printNodeSettingsSchema = z.object({ apiKey: z.string() }).passthrough();

/** `GET /api/printnode`: the stored config, or null when there is none. */
export const printNodeSettingsOrNullSchema = z.record(z.unknown()).nullable();

// ── commerce portal: the buyers' public routes ──────────────────────────────

export const commercePortalConfigSchema = z.object({
  displayName: nullableString,
  logo: nullableString,
  primaryColor: nullableString,
  accentColor: nullableString,
});

/** `POST /auth/verify`: a session, or a picker when the email has several companies. */
export const commercePortalVerifySchema = z.union([
  z.object({
    token: z.string(),
    needsCompanyPicker: z.literal(false),
    companies: z.array(z.never()),
  }),
  z.object({
    token: z.null(),
    pickerToken: z.string(),
    needsCompanyPicker: z.literal(true),
    companies: z.array(z.object({ accessId: z.string(), companyId: z.string(), name: z.string() })),
  }),
]);

export const commercePortalSessionSchema = z.object({ token: z.string() });

export const commercePortalMeSchema = z.object({
  /** The buyer's person row, or their sign-in email when the row is gone. */
  person: z.object({ id: z.string(), displayName: z.string(), email: nullableString }),
  company: z.object({ id: z.string(), displayName: nullableString }),
  party: z
    .object({
      id: z.string(),
      paymentTerms: nullableString,
      creditLimit: nullableRecord,
      outstandingBalance: nullableString,
      currency: nullableString,
      billingAddress: nullableRecord,
      shippingAddress: nullableRecord,
    })
    .nullable(),
});

export const commerceInvoiceRowSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    invoiceNumber: nullableString,
    type: z.string(),
    status: z.string(),
    contactId: z.string(),
    contactName: nullableString,
    contactEmail: nullableString,
    counterpartyId: nullableString,
    issueDate: z.string(),
    dueDate: z.string(),
    paidAt: nullableString,
    currency: nullableString,
    subtotal: nullableString,
    discountTotal: nullableString,
    taxTotal: nullableString,
    total: nullableString,
    amountPaid: nullableString,
    balanceDue: nullableString,
    reference: nullableString,
    notes: nullableString,
    billingAddress: nullableRecord,
    ...timestamps,
  })
  .passthrough();

export const commerceInvoiceItemRowSchema = z
  .object({
    id: z.string(),
    invoiceId: z.string(),
    entityId: z.string(),
    description: z.string(),
    quantity: nullableString,
    unitPrice: z.string(),
    unit: nullableString,
    discountPercent: nullableString,
    taxRate: nullableString,
    taxAmount: nullableString,
    lineTotal: nullableString,
    lineTotalWithTax: nullableString,
    productId: nullableString,
    sortOrder: nullableNumber,
    ...timestamps,
  })
  .passthrough();

export const commerceInvoiceWithItemsSchema = commerceInvoiceRowSchema.extend({
  items: z.array(commerceInvoiceItemRowSchema),
});

export const commerceReturnReasonRowSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    label: z.string(),
    description: nullableString,
    groupId: nullableString,
    displayOrder: nullableNumber,
    isActive: nullableBoolean,
    requiresPhotos: nullableBoolean,
    requiresDetails: nullableBoolean,
    ...timestamps,
  })
  .passthrough();

export const commerceReturnRowSchema = z
  .object({
    id: z.string(),
    returnNumber: z.string(),
    status: z.string(),
    originalOrderId: nullableString,
    customerId: nullableString,
    customerName: nullableString,
    customerEmail: nullableString,
    reason: nullableString,
    reasonDetails: nullableString,
    items: z.array(z.record(z.unknown())).nullable(),
    customerNotes: nullableString,
    approvalStatus: nullableString,
    ...timestamps,
  })
  .passthrough();

// ── commerce portal: the staff routes ───────────────────────────────────────

export const commercePortalSettingsSchema = z.object({
  id: nullableString,
  isEnabled: z.boolean(),
  displayName: nullableString,
  logo: nullableString,
  primaryColor: nullableString,
  accentColor: nullableString,
  portalUrl: nullableString,
  workspaceSlug: nullableString,
});

export const commercePortalAccessRowSchema = z
  .object({
    id: z.string(),
    personId: z.string(),
    companyId: z.string(),
    email: z.string(),
    status: z.enum(['invited', 'active', 'revoked']),
    invitedBy: nullableString,
    invitedAt: nullableString,
    lastLoginAt: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
