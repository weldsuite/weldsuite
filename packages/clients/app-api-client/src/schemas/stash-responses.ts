/**
 * Response shapes of stash-api (WeldStash, the WMS): warehouses, zones,
 * locations, stock buckets and the stock ledger, movements, putaway tasks,
 * pick lists, pickers, suppliers, purchase orders, cycle counts, boxes and
 * the activity log.
 *
 * The platform reads these through TypeScript interfaces
 * (`domains/warehouses.ts`, `domains/inventory.ts`, `domains/pick-lists.ts`);
 * these Zod schemas mirror them so the Rust backend's answers are checked
 * against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-stash.ts`).
 * Rows are `.passthrough()`: the routes answer whole table rows, and the
 * schemas pin the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const nullableInt = z.number().int().nullable();
const nullableBool = z.boolean().nullable();
/** A Drizzle `numeric` column: read back as a string. */
const numericText = z.string().nullable();
const jsonObject = z.record(z.unknown()).nullable();

/** `{ id }`: what most creates and updates answer. */
export const stashIdRefSchema = z.object({ id: z.string() });

/** `{ id, status }`: a status change. */
export const stashStatusResultSchema = z.object({ id: z.string(), status: z.string() });

/** The cursor pagination block. */
export const stashPaginationSchema = z.object({
  totalCount: z.number().int(),
  hasMore: z.boolean(),
  cursor: z.string().nullable(),
});

// ── warehouses, zones, locations, boxes ─────────────────────────────────────

export const warehouseRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    code: nullableString,
    description: nullableString,
    addressLine1: nullableString,
    city: nullableString,
    postalCode: nullableString,
    country: nullableString,
    contactName: nullableString,
    isDefault: nullableBool,
    isActive: nullableBool,
    priority: nullableInt,
    metadata: z.unknown(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: nullableString,
  })
  .passthrough();

export const warehouseZoneRowSchema = z
  .object({
    id: z.string(),
    warehouseId: z.string(),
    name: z.string(),
    code: nullableString,
    description: nullableString,
    zoneType: nullableString,
    isActive: nullableBool,
    priority: nullableInt,
    temperatureControlled: nullableBool,
    minTemperature: nullableInt,
    maxTemperature: nullableInt,
    temperatureUnit: nullableString,
    totalLocations: nullableInt,
    pickingSequence: nullableInt,
    metadata: jsonObject,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const warehouseLocationRowSchema = z
  .object({
    id: z.string(),
    warehouseId: z.string(),
    zoneId: nullableString,
    name: z.string(),
    code: z.string(),
    barcode: nullableString,
    locationType: nullableString,
    length: numericText,
    width: numericText,
    height: numericText,
    maxWeight: numericText,
    maxItems: nullableInt,
    currentItems: nullableInt,
    isActive: nullableBool,
    isEmpty: nullableBool,
    isBlocked: nullableBool,
    pickingSequence: nullableInt,
    isPrimaryPick: nullableBool,
    abcClass: nullableString,
    metadata: jsonObject,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const boxRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    length: z.string(),
    width: z.string(),
    height: z.string(),
    dimensionUnit: z.string(),
    weightUnit: z.string(),
    type: z.string(),
    isDefault: nullableBool,
    isActive: nullableBool,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

// ── suppliers, purchase orders, cycle counts ────────────────────────────────

export const wmsSupplierRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    code: nullableString,
    email: nullableString,
    currency: nullableString,
    isActive: nullableBool,
    status: nullableString,
    rating: nullableInt,
    tags: z.array(z.string()).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const purchaseOrderRowSchema = z
  .object({
    id: z.string(),
    poNumber: z.string(),
    supplierId: nullableString,
    warehouseId: nullableString,
    status: z.string(),
    orderDate: nullableString,
    expectedDate: nullableString,
    currency: nullableString,
    total: numericText,
    itemCount: nullableInt,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const cycleCountRowSchema = z
  .object({
    id: z.string(),
    countNumber: z.string(),
    warehouseId: z.string(),
    status: z.string(),
    scheduledDate: nullableString,
    notes: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

// ── stock: buckets, the ledger, adjustments, movements ──────────────────────

export const inventoryBucketSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    warehouseId: z.string(),
    locationId: nullableString,
    variantId: nullableString,
    quantityOnHand: z.number().int(),
    quantityAllocated: nullableInt,
    quantityAvailable: nullableInt,
    quantityIncoming: nullableInt,
    lotNumber: nullableString,
    expiryDate: nullableString,
    unitCost: numericText,
    totalValue: numericText,
    status: nullableString,
    isQuarantined: nullableBool,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** A bucket in `GET /api/inventory`, with its product, warehouse and location. */
export const inventoryListRowSchema = inventoryBucketSchema.extend({
  productName: nullableString,
  productSku: nullableString,
  warehouseName: nullableString,
  locationCode: nullableString,
});

export const stockAdjustmentRowSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    variantId: nullableString,
    warehouseId: nullableString,
    locationId: nullableString,
    inventoryId: nullableString,
    type: z.string(),
    previousQuantity: z.number().int(),
    adjustmentQuantity: z.number().int(),
    newQuantity: z.number().int(),
    lotNumber: nullableString,
    reason: nullableString,
    sourceType: nullableString,
    sourceId: nullableString,
    sourceNumber: nullableString,
    requiresApproval: nullableInt,
    approvalStatus: nullableString,
    createdAt: z.string(),
  })
  .passthrough();

/** An entry of `GET /api/inventory/ledger`, with its names. */
export const inventoryLedgerEntrySchema = stockAdjustmentRowSchema.extend({
  productName: nullableString,
  productSku: nullableString,
  warehouseName: nullableString,
  locationCode: nullableString,
});

/** `POST /api/inventory/adjust`. */
export const inventoryAdjustResultSchema = z.object({
  inventoryId: z.string(),
  adjustmentId: z.string(),
  previousQuantity: z.number().int(),
  quantityOnHand: z.number().int(),
  productQuantity: z.number().int(),
});

const transferLegSchema = z.object({ inventoryId: z.string(), quantityOnHand: z.number().int() });

/** `POST /api/inventory/transfer`. */
export const inventoryTransferResultSchema = z.object({
  movementId: z.string(),
  movementNumber: z.string(),
  from: transferLegSchema,
  to: transferLegSchema,
});

export const inventoryMovementRowSchema = z
  .object({
    id: z.string(),
    movementNumber: z.string(),
    movementType: z.string(),
    status: z.string(),
    sourceWarehouseId: nullableString,
    destWarehouseId: nullableString,
    productId: z.string(),
    quantity: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

// ── putaway ────────────────────────────────────────────────────────────────

export const putawayTaskSchema = z.object({
  id: z.string(),
  movementNumber: z.string(),
  productId: z.string(),
  productName: nullableString,
  productSku: nullableString,
  quantity: z.number().int(),
  sourceLocationId: nullableString,
  destLocationId: nullableString,
  destLocationCode: nullableString,
  status: z.string(),
  priority: nullableString,
  assignedTo: nullableString,
  assignedToName: nullableString,
  notes: nullableString,
  createdAt: z.string(),
  completedAt: nullableString,
});

/** `GET /api/putaway/:id`. */
export const putawayTaskDetailSchema = putawayTaskSchema.extend({
  sourceType: nullableString,
  sourceId: nullableString,
  startedAt: nullableString,
});

/** `GET /api/putaway`: the page and the status counts. */
export const putawayListBodySchema = z.object({
  data: z.array(putawayTaskSchema),
  pagination: stashPaginationSchema,
  counts: z.object({
    total: z.number().int(),
    pending: z.number().int(),
    in_progress: z.number().int(),
    completed: z.number().int(),
    cancelled: z.number().int(),
  }),
});

export const putawayCreatedSchema = z.object({ id: z.string(), movementNumber: z.string() });
export const putawayAssignedSchema = z.object({ id: z.string(), assignedTo: z.string().nullable().optional() });
export const putawayCompletedSchema = z.object({ id: z.string(), status: z.string(), locationId: z.string() });

// ── pick lists ─────────────────────────────────────────────────────────────

export const pickListItemRowSchema = z
  .object({
    id: z.string(),
    pickListId: z.string(),
    orderId: nullableString,
    orderItemId: nullableString,
    productId: z.string(),
    variantId: nullableString,
    sku: nullableString,
    name: z.string(),
    locationId: nullableString,
    locationCode: nullableString,
    inventoryId: nullableString,
    quantityRequired: z.number().int(),
    quantityPicked: nullableInt,
    quantityShort: nullableInt,
    lotNumber: nullableString,
    status: nullableString,
    pickSequence: nullableInt,
    pickedAt: nullableString,
  })
  .passthrough();

export const pickListRowSchema = z
  .object({
    id: z.string(),
    pickListNumber: z.string(),
    warehouseId: z.string(),
    status: z.string(),
    priority: nullableString,
    assignedTo: nullableString,
    assignedToName: nullableString,
    totalItems: nullableInt,
    pickedItems: nullableInt,
    totalQuantity: nullableInt,
    pickedQuantity: nullableInt,
    orderIds: z.array(z.string()).nullable(),
    orderCount: nullableInt,
    pickType: nullableString,
    packedAt: nullableString,
    shippedAt: nullableString,
    shipmentId: nullableString,
    parcelId: nullableString,
    notes: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** `GET /api/pick-lists/:id`: the list, its lines, the recipient and whether it needs a carrier. */
export const pickListDetailSchema = pickListRowSchema.extend({
  items: z.array(pickListItemRowSchema),
  requiresShipping: z.boolean(),
  recipient: z
    .object({
      name: nullableString,
      email: nullableString,
      phone: nullableString,
      line1: nullableString,
      line2: nullableString,
      city: nullableString,
      postalCode: nullableString,
      country: nullableString,
    })
    .nullable(),
});

export const pickListCreatedSchema = z.object({ id: z.string(), pickListNumber: z.string() });

export const pickListGeneratedSchema = z.object({
  id: z.string(),
  pickListNumber: z.string(),
  status: z.string(),
  itemCount: z.number().int(),
});

export const pickListPickResultSchema = z.object({
  id: z.string(),
  status: z.string(),
  quantityPicked: z.number().int(),
  quantityShort: z.number().int(),
});

export const pickListPackResultSchema = z.object({
  id: z.string(),
  status: z.string(),
  parcelId: z.string().optional(),
});

export const pickListShipResultSchema = z.object({
  id: z.string(),
  status: z.string(),
  shipmentId: z.string().nullable().optional(),
  parcelId: z.string().nullable().optional(),
  trackingNumber: z.string().nullable().optional(),
  trackingUrl: z.string().nullable().optional(),
  labelUrl: z.string().nullable().optional(),
  labelPdfBase64: z.string().nullable().optional(),
  carrierName: z.string().nullable().optional(),
  shippingOptionCode: z.string().nullable().optional(),
});

// ── pickers ────────────────────────────────────────────────────────────────

export const pickerRowSchema = z
  .object({
    id: z.string(),
    userId: nullableString,
    name: z.string(),
    email: nullableString,
    phone: nullableString,
    warehouseId: nullableString,
    role: nullableString,
    status: nullableString,
    skills: z.array(z.string()).nullable(),
    notes: nullableString,
    metadata: jsonObject,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const pickerStatsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  inactive: z.number().int(),
  on_break: z.number().int(),
});

/** `GET /api/pickers`: the page and the status stats. */
export const pickerListBodySchema = z.object({
  data: z.array(pickerRowSchema),
  pagination: stashPaginationSchema,
  stats: pickerStatsSchema,
});

/** `GET /api/pickers/:id`: the picker and their pick performance. */
export const pickerDetailSchema = pickerRowSchema.extend({
  performance: z.object({
    totalPicklists: z.number().int(),
    completedPicklists: z.number().int(),
    totalItems: z.number().int(),
    pickedItems: z.number().int(),
  }),
});

// ── activity log ───────────────────────────────────────────────────────────

export const wmsActivityRowSchema = z
  .object({
    id: z.string(),
    activityType: z.string(),
    entityType: nullableString,
    entityId: nullableString,
    userId: nullableString,
    warehouseId: nullableString,
    description: nullableString,
    metadata: jsonObject,
    createdAt: z.string(),
  })
  .passthrough();

/** `GET /api/wms-activity`: the page and the counts per activity type. */
export const wmsActivityListBodySchema = z.object({
  data: z.array(wmsActivityRowSchema),
  pagination: stashPaginationSchema,
  counts: z.object({
    total: z.number().int(),
    create: z.number().int(),
    update: z.number().int(),
    delete: z.number().int(),
    receive: z.number().int(),
    ship: z.number().int(),
    pick: z.number().int(),
    pack: z.number().int(),
    adjust: z.number().int(),
    transfer: z.number().int(),
  }),
});

/** `GET /api/wms-activity/summary`. */
export const wmsActivitySummarySchema = z.object({
  period: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  totalActivities: z.number().int(),
  receives: z.number().int(),
  shipments: z.number().int(),
  picks: z.number().int(),
  packs: z.number().int(),
  adjustments: z.number().int(),
  transfers: z.number().int(),
  uniqueUsers: z.number().int(),
});
