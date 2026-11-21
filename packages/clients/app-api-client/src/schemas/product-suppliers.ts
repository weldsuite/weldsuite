import { z } from 'zod';

// ============================================================================
// Product suppliers: who a product (or variant) is bought from, and on what
// terms (WeldStash purchasing). `/api/product-suppliers`, Rust backend only
// (the Kubernetes editions). Permission prefix: `suppliers:*`.
//
// Numeric columns arrive as strings (Drizzle style); requests carry numbers.
// ============================================================================

const productSupplierFields = {
  supplierSku: z.string().max(100).nullish(),
  supplierProductName: z.string().max(255).nullish(),
  unitCost: z.number().min(0).nullish(),
  currency: z.string().length(3).nullish(),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  minOrderQty: z.number().int().min(1).nullish(),
  orderMultiple: z.number().int().min(1).optional(),
  isPreferred: z.boolean().optional(),
};

export const createProductSupplierSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().nullish(),
  supplierId: z.string().min(1),
  ...productSupplierFields,
});

/** Every field optional; the product, variant and supplier never change. */
export const updateProductSupplierSchema = z.object(productSupplierFields).partial();

export type CreateProductSupplierInput = z.infer<typeof createProductSupplierSchema>;
export type UpdateProductSupplierInput = z.infer<typeof updateProductSupplierSchema>;

/** A product supplier row as the API lists it, with the supplier and product names joined in. */
export interface ProductSupplier {
  id: string;
  productId: string;
  variantId: string | null;
  supplierId: string;
  supplierSku: string | null;
  supplierProductName: string | null;
  /** Numeric text, e.g. `"12.5000"`. */
  unitCost: string | null;
  currency: string | null;
  leadTimeDays: number | null;
  minOrderQty: number | null;
  orderMultiple: number;
  isPreferred: boolean;
  createdAt: string;
  updatedAt: string;
  supplierName: string | null;
  supplierCode: string | null;
  supplierCurrency: string | null;
  /** The supplier's own default lead time, used when `leadTimeDays` is null. */
  supplierLeadTimeDays: number | null;
  productName: string | null;
  productSku: string | null;
}
