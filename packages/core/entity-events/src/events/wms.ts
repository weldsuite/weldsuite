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
} as const;
