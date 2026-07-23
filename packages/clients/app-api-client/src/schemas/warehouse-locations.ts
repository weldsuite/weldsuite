import { z } from 'zod';

// ============================================================================
// Warehouse Locations — physical storage positions within a warehouse zone.
// A location always belongs to exactly one warehouse; the parent
// `warehouseId` is immutable after creation (use a transfer instead).
//
// Backed by the `warehouse_locations` table
// (packages/db/src/schema/warehouse-locations.ts).
// Permission prefix: `locations:*`.
// ============================================================================

export const createWarehouseLocationSchema = z.object({
  warehouseId: z.string().min(1).max(30),
  zoneId: z.string().max(30).nullish(),
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  barcode: z.string().max(100).optional(),

  // Physical structure
  aisle: z.string().max(20).optional(),
  rack: z.string().max(20).optional(),
  shelf: z.string().max(20).optional(),
  bin: z.string().max(20).optional(),
  level: z.number().int().optional(),

  // storage | picking | bulk | reserve | staging | dock
  locationType: z.string().max(50).default('storage'),

  // Dimensions (stored as numeric strings in DB)
  length: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  dimensionUnit: z.string().max(10).default('cm'),

  // Capacity
  maxWeight: z.number().optional(),
  weightUnit: z.string().max(10).default('kg'),
  maxItems: z.number().int().optional(),

  // Status
  isActive: z.boolean().default(true),

  // Picking
  pickingSequence: z.number().int().default(0),
  isPrimaryPick: z.boolean().default(false),

  // A | B | C velocity classification
  abcClass: z.string().max(1).optional(),

  metadata: z.record(z.unknown()).optional(),
});

// The parent warehouse cannot be reassigned — omit it from updates.
export const updateWarehouseLocationSchema = createWarehouseLocationSchema
  .partial()
  .omit({ warehouseId: true });

export type CreateWarehouseLocationInput = z.infer<typeof createWarehouseLocationSchema>;
export type UpdateWarehouseLocationInput = z.infer<typeof updateWarehouseLocationSchema>;
