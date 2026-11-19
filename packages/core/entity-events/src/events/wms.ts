/**
 * WeldStash (WMS) entity events.
 */
export const WMS_ENTITY_EVENTS = {
  inventory: ['created', 'updated', 'deleted'],
  picker: ['created', 'updated', 'deleted'],
  picklist: ['created', 'updated', 'deleted', 'completed'],
  putaway: ['created', 'updated', 'deleted', 'completed'],
  warehouse: ['created', 'updated', 'deleted'],
  warehouse_zone: ['created', 'updated', 'deleted'],
  wms_adjustment: ['created', 'updated', 'deleted'],
  wms_category: ['created', 'updated', 'deleted'],
  wms_cycle_count: ['created', 'updated', 'deleted', 'completed'],
  wms_inventory: ['created', 'updated', 'deleted'],
  wms_inventory_movement: ['created', 'updated', 'deleted'],
  wms_location: ['created', 'updated', 'deleted'],
  wms_order: ['created', 'updated', 'deleted', 'completed'],
  wms_product: ['created', 'updated', 'deleted', 'archived'],
  // Replenishment (weldsuite-documentation/plans/weldstash-replenishment.md). Published by the
  // Rust backend only (rust/modules/stash).
  product_supplier: ['created', 'updated', 'deleted'],
  reorder_rule: ['created', 'updated', 'deleted'],
  replenishment_settings: ['updated'],
  replenishment_run: ['created', 'completed', 'failed'],
  sales_history_import: ['created', 'completed', 'deleted'],
} as const;
