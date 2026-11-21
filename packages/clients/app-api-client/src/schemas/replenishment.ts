import { z } from 'zod';

// ============================================================================
// WeldStash replenishment: settings, item plans, reorder rules, planning runs,
// incoming stock, sales history imports and draft purchase orders from plans.
// `/api/replenishment/*`, Rust backend only (the Kubernetes editions).
//
// Permissions: `inventory:read` (reads), `inventory:update` (dismiss, restore),
// `inventory:manage` (settings, rules, runs, imports), `orders:create`
// (create purchase orders). Numeric columns arrive as strings (Drizzle style);
// request bodies carry JSON numbers.
// ============================================================================

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// ── Settings ────────────────────────────────────────────────────────────────

export const updateReplenishmentSettingsSchema = z
  .object({
    replenishmentEnabled: z.boolean(),
    defaultServiceLevel: z.number().min(0.5).max(0.999),
    defaultReviewPeriodDays: z.number().int().min(1).max(90),
    lookbackDays: z.number().int().min(28).max(730),
    defaultLeadTimeDays: z.number().int().min(0).max(365),
    demandWarehouseId: z.string().nullable(),
    historyCutoverDate: isoDate.nullable(),
    runHourUtc: z.number().int().min(0).max(23),
  })
  .partial();
export type UpdateReplenishmentSettingsInput = z.infer<typeof updateReplenishmentSettingsSchema>;

export interface ReplenishmentSettings {
  id: string;
  replenishmentEnabled: boolean;
  /** Numeric text, e.g. `"0.950"`. */
  defaultServiceLevel: string;
  defaultReviewPeriodDays: number;
  lookbackDays: number;
  defaultLeadTimeDays: number;
  demandWarehouseId: string | null;
  historyCutoverDate: string | null;
  runHourUtc: number;
  createdAt?: string;
  updatedAt?: string;
}

// ── Plans ───────────────────────────────────────────────────────────────────

export const PLAN_URGENCIES = ['out_of_stock', 'lead_time', 'review'] as const;
export type PlanUrgency = (typeof PLAN_URGENCIES)[number];
export const PLAN_CONFIDENCES = ['none', 'low', 'ok'] as const;
export type PlanConfidence = (typeof PLAN_CONFIDENCES)[number];
export const PLAN_REVIEW_STATUSES = ['none', 'open', 'dismissed', 'ordered'] as const;
export type PlanReviewStatus = (typeof PLAN_REVIEW_STATUSES)[number];
export type PlanMethod = 'seasonal' | 'level' | 'sparse' | 'min_max' | 'none';

export interface ListPlansQuery {
  needsReorder?: boolean;
  status?: PlanReviewStatus;
  supplierId?: string;
  warehouseId?: string;
  confidence?: PlanConfidence;
  urgency?: PlanUrgency;
  search?: string;
  limit?: number;
  cursor?: string;
}

/** A plan row (`stash_item_plans`) with the names and supplier terms joined in. */
export interface ReplenishmentPlan {
  id: string;
  itemKey: string;
  productId: string;
  variantId: string | null;
  warehouseId: string;
  runId: string | null;
  computedAt: string | null;
  method: string;
  confidence: string;
  historyDays: number;
  nonzeroDays: number;
  avgDailyDemand: string | null;
  demandStdDev: string | null;
  seasonality: number[] | null;
  forecast30d: string | null;
  forecast90d: string | null;
  leadTimeDays: number | null;
  reviewPeriodDays: number | null;
  serviceLevel: string | null;
  productSupplierId: string | null;
  supplierId: string | null;
  safetyStock: number | null;
  reorderPoint: number | null;
  orderUpTo: number | null;
  onHand: number;
  allocated: number;
  incoming: number;
  openDemand: number;
  inventoryPosition: number;
  daysOfCover: string | null;
  stockoutDate: string | null;
  suggestedQty: number;
  suggestedValue: string | null;
  reviewStatus: string;
  dismissedUntil: string | null;
  dismissedBy: string | null;
  dismissedQty: number | null;
  purchaseOrderId: string | null;
  productName: string | null;
  productSku: string | null;
  variantName: string | null;
  warehouseName: string | null;
  warehouseManagedByConnectionId: string | null;
  supplierName: string | null;
  currency: string | null;
  unitCost: string | null;
  minOrderQty: number | null;
  orderMultiple: number | null;
}

export interface ReorderRule {
  id: string;
  itemKey: string;
  productId: string;
  variantId: string | null;
  warehouseId: string;
  method: 'auto' | 'min_max' | 'off';
  minQty: number | null;
  maxQty: number | null;
  serviceLevel: string | null;
  reviewPeriodDays: number | null;
  leadTimeDaysOverride: number | null;
  productSupplierId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetail {
  plan: ReplenishmentPlan;
  rule: ReorderRule | null;
  /** The product supplier the plan used (the rule's choice, else the preferred one). */
  productSupplier: Record<string, unknown> | null;
}

export interface DemandPoint {
  /** Monday of the week, `YYYY-MM-DD` (UTC). */
  weekStart: string;
  quantity: number;
}

export interface PlanDemand {
  history: DemandPoint[];
  forecast: DemandPoint[];
}

/** `POST /plans/{id}/dismiss`: snooze until an ISO time (default: 7 days). */
export const dismissPlanSchema = z.object({ until: z.string().optional() });
export type DismissPlanInput = z.infer<typeof dismissPlanSchema>;

// ── Rules ───────────────────────────────────────────────────────────────────

export const upsertReorderRuleSchema = z
  .object({
    productId: z.string().min(1),
    variantId: z.string().nullish(),
    warehouseId: z.string().min(1),
    method: z.enum(['auto', 'min_max', 'off']),
    minQty: z.number().int().min(0).nullish(),
    maxQty: z.number().int().min(0).nullish(),
    serviceLevel: z.number().min(0.5).max(0.999).nullish(),
    reviewPeriodDays: z.number().int().min(1).max(90).nullish(),
    leadTimeDaysOverride: z.number().int().min(0).max(365).nullish(),
    productSupplierId: z.string().nullish(),
  })
  .refine(
    (rule) =>
      rule.method !== 'min_max' ||
      (typeof rule.minQty === 'number' && typeof rule.maxQty === 'number' && rule.minQty <= rule.maxQty),
    { message: 'Min and max are required, and min cannot exceed max', path: ['maxQty'] },
  );
export type UpsertReorderRuleInput = z.infer<typeof upsertReorderRuleSchema>;

export interface ListRulesQuery {
  productId?: string;
  variantId?: string;
  warehouseId?: string;
}

// ── Runs ────────────────────────────────────────────────────────────────────

export interface PlanningRun {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  itemsPlanned: number;
  itemsToReorder: number;
  error: string | null;
  startedBy: string | null;
  createdAt: string;
}

// ── Draft purchase orders from plans ────────────────────────────────────────

export const createPurchaseOrdersFromPlansSchema = z.object({
  planIds: z.array(z.string().min(1)).min(1).max(500),
  quantities: z.record(z.number().int().min(1)).optional(),
});
export type CreatePurchaseOrdersFromPlansInput = z.infer<typeof createPurchaseOrdersFromPlansSchema>;

export type SkippedPlanReason = 'not_found' | 'no_supplier' | 'zero_quantity' | 'already_ordered';

export interface CreatedPurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string | null;
  warehouseId: string;
  lineCount: number;
  total: string | number;
}

export interface CreatePurchaseOrdersFromPlansResult {
  purchaseOrders: CreatedPurchaseOrder[];
  skipped: Array<{ planId: string; reason: SkippedPlanReason }>;
}

// ── Incoming ────────────────────────────────────────────────────────────────

export interface ListIncomingQuery {
  productId?: string;
  variantId?: string;
  warehouseId?: string;
}

export interface IncomingStock {
  productId: string;
  variantId: string | null;
  warehouseId: string;
  quantity: number;
  nextExpectedDate: string | null;
}

// ── CSV sales history imports ───────────────────────────────────────────────

export const IMPORT_CHUNK_SIZE = 1000;

export const salesHistoryRowSchema = z.object({
  date: isoDate,
  sku: z.string().min(1),
  quantity: z.number().int(),
  warehouseCode: z.string().optional(),
  reference: z.string().optional(),
});
export type SalesHistoryRowInput = z.infer<typeof salesHistoryRowSchema>;

export const importRowsSchema = z.object({
  rows: z.array(salesHistoryRowSchema).min(1).max(IMPORT_CHUNK_SIZE),
  /**
   * 0-based index of `rows[0]` in the file. Sent on every chunk, it makes a
   * retried chunk replace its earlier rows instead of adding them again.
   */
  startRow: z.number().int().min(0).max(1_000_000_000).optional(),
});
export type ImportRowsInput = z.infer<typeof importRowsSchema>;

export interface SalesHistoryImport {
  id: string;
  fileName: string;
  status: 'processing' | 'done' | 'failed';
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  /** The first 100 SKUs that matched nothing. */
  unmatchedSkus: string[] | null;
  dateFrom: string | null;
  dateTo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportRowsResult {
  imported: number;
  skipped: number;
  unmatchedSkus: string[];
}

export interface CompleteImportResult {
  import: SalesHistoryImport;
  suggestedCutoverDate: string | null;
}
