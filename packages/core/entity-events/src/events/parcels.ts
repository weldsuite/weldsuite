/**
 * Parcel tracking + return portal entity events.
 */
export const PARCELS_ENTITY_EVENTS = {
  parcel: ['created', 'updated', 'deleted'],
  parcel_box: ['created', 'updated', 'deleted'],
  parcel_carrier: ['created', 'updated', 'deleted'],
  parcel_order: ['created', 'updated', 'deleted'],
  parcel_pickup: ['created', 'updated', 'deleted', 'completed'],
  parcel_wallet: ['created', 'updated', 'deleted'],
  parcel_settings: ['updated'],
  notification_template: ['created', 'updated', 'deleted'],
} as const;
