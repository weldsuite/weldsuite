/**
 * Parcel entity events. WeldStash's carrier shipping (Rust backend only)
 * publishes `parcel:shipped` when a labelled piece is handed over and
 * `parcel:delivered` when the carrier reports it delivered (ADR STASH-011).
 */
export const PARCELS_ENTITY_EVENTS = {
  parcel: ['created', 'updated', 'deleted', 'shipped', 'delivered'],
  parcel_box: ['created', 'updated', 'deleted'],
  parcel_carrier: ['created', 'updated', 'deleted'],
  parcel_order: ['created', 'updated', 'deleted'],
  parcel_pickup: ['created', 'updated', 'deleted', 'completed'],
  parcel_wallet: ['created', 'updated', 'deleted'],
  parcel_settings: ['updated'],
} as const;
