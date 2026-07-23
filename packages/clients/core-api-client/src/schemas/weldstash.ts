import { z } from 'zod';

// ============================================================================
// Products (shared `products` table — also used by WeldCommerce)
// ============================================================================

export const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  sku: z.string().min(1).max(100).optional(),
  barcode: z.string().max(100).optional(),
  description: z.string().optional(),
  price: z.number().min(0).default(0),
  costPrice: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  lowStockThreshold: z.number().int().min(0).default(5),
  trackInventory: z.boolean().default(true),
  status: z.enum(['active', 'inactive', 'draft']).default('active'),
  brand: z.string().max(255).optional(),
  vendor: z.string().max(255).optional(),
});

export const updateProductSchema = createProductSchema.partial();

// ============================================================================
// Suppliers (`parties` table — role = 'supplier')
// ============================================================================

export const createSupplierSchema = z.object({
  companyName: z.string().min(1).max(255),
  tradingName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  website: z.string().max(500).optional(),
  vatNumber: z.string().max(50).optional(),
  registrationNumber: z.string().max(100).optional(),
  paymentTerms: z.string().max(50).optional(),
  currency: z.string().length(3).optional(),
  iban: z.string().max(34).optional(),
  bic: z.string().max(11).optional(),
  notes: z.string().optional(),
  billingAddress: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .passthrough()
    .optional(),
  status: z.enum(['prospect', 'active', 'inactive', 'churned', 'suspended']).default('active'),
});

export const updateSupplierSchema = createSupplierSchema.partial();

// ============================================================================
// Warehouses
// ============================================================================

export const createWarehouseSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(50).optional(),
  description: z.string().optional(),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  contactName: z.string().max(255).optional(),
  contactEmail: z.string().email().optional().or(z.literal('')),
  contactPhone: z.string().max(50).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  timezone: z.string().max(50).optional(),
});

export const updateWarehouseSchema = createWarehouseSchema.partial();

// ============================================================================
// Stock (inventory)
// ============================================================================

export const adjustStockSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().nullish(),
  delta: z.number().int(),
  reason: z.string().min(1).max(500),
  lotNumber: z.string().max(100).optional(),
  unitCost: z.number().min(0).optional(),
});

// ============================================================================
// Shared list query
// ============================================================================

export const weldstashListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
});

export const listStockQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  productId: z.string().optional(),
  warehouseId: z.string().optional(),
  lowStockOnly: z.coerce.boolean().optional(),
});

// ============================================================================
// Inferred input types
// ============================================================================

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type WeldstashListQuery = z.infer<typeof weldstashListQuerySchema>;
export type ListStockQuery = z.infer<typeof listStockQuerySchema>;

// ============================================================================
// Response types
// ============================================================================

export interface WeldstashProduct {
  id: string;
  name: string;
  slug?: string | null;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  price: number;
  costPrice?: number | null;
  currency?: string | null;
  trackInventory?: boolean | null;
  lowStockThreshold?: number | null;
  inventoryQuantity?: number | null;
  status: string;
  brand?: string | null;
  vendor?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeldstashSupplier {
  id: string;
  companyName?: string | null;
  tradingName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  paymentTerms?: string | null;
  currency?: string | null;
  iban?: string | null;
  bic?: string | null;
  notes?: string | null;
  billingAddress?: unknown;
  status: string;
  role: string;
  type: string;
  createdAt: string;
  updatedAt: string;
}

export interface WeldstashWarehouse {
  id: string;
  name: string;
  code?: string | null;
  description?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  isDefault?: boolean | null;
  isActive?: boolean | null;
  timezone?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeldstashStockRow {
  id: string;
  productId: string;
  productName?: string | null;
  productSku?: string | null;
  warehouseId: string;
  warehouseName?: string | null;
  locationId?: string | null;
  locationCode?: string | null;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityAvailable: number;
  quantityIncoming: number;
  quantityOutgoing: number;
  lotNumber?: string | null;
  expiryDate?: string | null;
  unitCost?: number | null;
  status?: string | null;
  updatedAt: string;
}

export interface WeldstashStockMovement {
  id: string;
  movementNumber: string;
  movementType: string;
  productId: string;
  productName?: string | null;
  sku?: string | null;
  quantity: number;
  sourceWarehouseId?: string | null;
  destWarehouseId?: string | null;
  sourceLocationId?: string | null;
  destLocationId?: string | null;
  lotNumber?: string | null;
  reason?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  createdAt: string;
}
