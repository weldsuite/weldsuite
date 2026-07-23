import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Carrier integration types
export type CarrierIntegrationType = 'api' | 'manual' | 'sendcloud' | 'easypost';

// Carrier type enum (matches API backend)
export type CarrierType = 0 | 1 | 2 | 3 | 4 | 5; // PostNL, DHL, DPD, UPS, FedEx, GLS

export interface CarrierConfiguration {
  carrier: CarrierType;
  apiKey: string;
  apiSecret?: string;
  accountNumber?: string;
  customerNumber?: string;
  customerCode?: string;
  useSandbox: boolean;
  additionalSettings?: Record<string, string>;
}

export interface CarrierFeatures {
  tracking: boolean;
  insurance: boolean;
  signatureOnDelivery: boolean;
  saturdayDelivery: boolean;
  returns: boolean;
  pickups: boolean;
  multiParcel: boolean;
  international: boolean;
  customs: boolean;
  labelPrinting: boolean;
  servicePoints: boolean;
  cod: boolean; // Cash on Delivery
}

export interface CarrierSettings {
  defaultServiceType?: string;
  defaultPackageType?: string;
  labelFormat?: 'PDF' | 'PNG' | 'ZPL';
  labelSize?: string;
  autoTrack?: boolean;
  trackingInterval?: number;
  webhookUrl?: string;
}

export const carriers = pgTable('carriers', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }).notNull(),
  logo: varchar('logo', { length: 500 }),
  website: varchar('website', { length: 500 }),

  // Status
  isActive: boolean('is_active').default(true),
  isDefault: boolean('is_default').default(false),

  // Integration
  integrationType: varchar('integration_type', { length: 20 }).notNull().default('manual'),
  apiCredentials: jsonb('api_credentials').$type<CarrierConfiguration>(),

  // Services
  supportedServices: jsonb('supported_services').$type<string[]>(),
  supportedCountries: jsonb('supported_countries').$type<string[]>(),

  // Features
  features: jsonb('features').$type<CarrierFeatures>(),

  // Tracking
  trackingUrlTemplate: varchar('tracking_url_template', { length: 500 }),

  // Contact
  supportEmail: varchar('support_email', { length: 255 }),
  supportPhone: varchar('support_phone', { length: 50 }),
  accountNumber: varchar('account_number', { length: 100 }),

  // Settings
  settings: jsonb('settings').$type<CarrierSettings>(),

  // Description
  description: text('description'),
}, (table) => [
  index('carriers_code_idx').on(table.code),
  index('carriers_is_active_idx').on(table.isActive),
]);

export type Carrier = typeof carriers.$inferSelect;
export type NewCarrier = typeof carriers.$inferInsert;
