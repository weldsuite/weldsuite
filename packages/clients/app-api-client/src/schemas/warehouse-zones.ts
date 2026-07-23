import { z } from 'zod';

// ============================================================================
// Warehouse Zones — logical areas within a warehouse (receiving, shipping,
// storage, staging, quarantine, returns). A zone always belongs to exactly
// one warehouse; the parent `warehouseId` is immutable after creation.
//
// Backed by the `warehouse_zones` table (packages/db/src/schema/warehouse-zones).
// Permission prefix: `warehouses:*` (zones are a sub-object of warehouses).
// ============================================================================

export const createWarehouseZoneSchema = z.object({
  warehouseId: z.string().min(1).max(30),
  name: z.string().min(1).max(255),
  code: z.string().max(50).optional(),
  description: z.string().optional(),

  // storage | receiving | shipping | staging | quarantine | returns
  zoneType: z.string().max(50).default('storage'),

  isActive: z.boolean().default(true),
  priority: z.number().int().default(0),

  // Temperature / environment control
  temperatureControlled: z.boolean().default(false),
  minTemperature: z.number().int().optional(),
  maxTemperature: z.number().int().optional(),
  temperatureUnit: z.string().max(5).default('C'),

  // Picking configuration
  pickingSequence: z.number().int().default(0),

  metadata: z.record(z.unknown()).optional(),
});

// The parent warehouse cannot be reassigned — omit it from updates.
export const updateWarehouseZoneSchema = createWarehouseZoneSchema
  .partial()
  .omit({ warehouseId: true });

export type CreateWarehouseZoneInput = z.infer<typeof createWarehouseZoneSchema>;
export type UpdateWarehouseZoneInput = z.infer<typeof updateWarehouseZoneSchema>;
