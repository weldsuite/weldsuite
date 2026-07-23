import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  numeric,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Parcel status types
export type ParcelStatus =
  | 'draft'
  | 'pending'
  | 'label_created'
  | 'shipped'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'returned'
  | 'cancelled';

export type PackageType = 'parcel' | 'letter' | 'pallet' | 'custom';
export type LabelFormat = 'PDF' | 'PNG' | 'ZPL';
export type WeightUnit = 'kg' | 'lb' | 'g' | 'oz';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface Dimensions {
  length: number;
  width: number;
  height: number;
  unit: 'cm' | 'in';
}

export interface Money {
  amount: number;
  currency: string;
}

export interface StatusEvent {
  status: ParcelStatus;
  timestamp: Date;
  location?: string;
  notes?: string;
}

export interface DeliveryProof {
  type: 'signature' | 'photo' | 'id_check';
  signatory?: string;
  imageUrl?: string;
  timestamp: Date;
}

export interface CustomsInfo {
  declarationId?: string;
  contentsType: 'gift' | 'sample' | 'merchandise' | 'documents' | 'other';
  restrictionType?: 'none' | 'quarantine' | 'sanitary' | 'other';
  restrictionComments?: string;
  customsItems: CustomsItem[];
  invoiceNumber?: string;
  certificateNumber?: string;
  totalValue: Money;
}

export interface CustomsItem {
  description: string;
  quantity: number;
  value: Money;
  weight: number;
  hsCode?: string;
  originCountry: string;
}

export const parcels = pgTable('parcels', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  trackingNumber: varchar('tracking_number', { length: 100 }),
  referenceNumber: varchar('reference_number', { length: 100 }),
  barcode: varchar('barcode', { length: 100 }),

  // Status
  status: varchar('status', { length: 30 }).notNull().default('draft'),
  statusHistory: jsonb('status_history').$type<StatusEvent[]>(),

  // Associations
  shipmentId: varchar('shipment_id', { length: 30 }),
  orderId: varchar('order_id', { length: 30 }),
  orderNumber: varchar('order_number', { length: 50 }),
  returnId: varchar('return_id', { length: 30 }),

  // Sender Information
  senderName: varchar('sender_name', { length: 255 }),
  senderCompany: varchar('sender_company', { length: 255 }),
  senderEmail: varchar('sender_email', { length: 255 }),
  senderPhone: varchar('sender_phone', { length: 50 }),
  senderAddress: jsonb('sender_address').$type<Address>(),

  // Recipient Information
  recipientName: varchar('recipient_name', { length: 255 }),
  recipientCompany: varchar('recipient_company', { length: 255 }),
  recipientEmail: varchar('recipient_email', { length: 255 }),
  recipientPhone: varchar('recipient_phone', { length: 50 }),
  recipientAddress: jsonb('recipient_address').$type<Address>(),

  // Package Details
  weight: numeric('weight', { precision: 10, scale: 3 }),
  weightUnit: varchar('weight_unit', { length: 5 }).default('kg'),
  dimensions: jsonb('dimensions').$type<Dimensions>(),
  packageType: varchar('package_type', { length: 20 }).default('parcel'),
  contents: text('contents'),
  value: jsonb('value').$type<Money>(),

  // Carrier & Shipping
  carrierId: varchar('carrier_id', { length: 30 }),
  carrierName: varchar('carrier_name', { length: 255 }),
  serviceType: varchar('service_type', { length: 50 }),
  serviceLevel: varchar('service_level', { length: 50 }),
  shippingCost: jsonb('shipping_cost').$type<Money>(),
  insuranceAmount: jsonb('insurance_amount').$type<Money>(),
  signatureRequired: boolean('signature_required').default(false),
  saturdayDelivery: boolean('saturday_delivery').default(false),

  // Dates
  shippedAt: timestamp('shipped_at'),
  estimatedDeliveryDate: timestamp('estimated_delivery_date'),
  actualDeliveryDate: timestamp('actual_delivery_date'),

  // Tracking
  currentLocation: varchar('current_location', { length: 255 }),
  lastScanLocation: varchar('last_scan_location', { length: 255 }),
  lastScanDate: timestamp('last_scan_date'),
  deliveryProof: jsonb('delivery_proof').$type<DeliveryProof>(),

  // Labels & Documents
  labelUrl: varchar('label_url', { length: 500 }),
  labelFormat: varchar('label_format', { length: 10 }),
  invoiceUrl: varchar('invoice_url', { length: 500 }),
  customsFormUrl: varchar('customs_form_url', { length: 500 }),

  // Customs (for international)
  customsInfo: jsonb('customs_info').$type<CustomsInfo>(),

  // Return Information
  isReturn: boolean('is_return').default(false),
  returnLabelUrl: varchar('return_label_url', { length: 500 }),
  returnTrackingNumber: varchar('return_tracking_number', { length: 100 }),

  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  notes: text('notes'),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
}, (table) => [
  index('parcels_tracking_number_idx').on(table.trackingNumber),
  index('parcels_status_idx').on(table.status),
  index('parcels_carrier_id_idx').on(table.carrierId),
  index('parcels_shipment_id_idx').on(table.shipmentId),
  index('parcels_order_id_idx').on(table.orderId),
  index('parcels_order_number_idx').on(table.orderNumber),
  index('parcels_created_at_idx').on(table.createdAt),
]);

export type Parcel = typeof parcels.$inferSelect;
export type NewParcel = typeof parcels.$inferInsert;
