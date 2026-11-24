import { z } from 'zod';

// ============================================================================
// WeldStash carrier shipping: carrier accounts (PostNL, DHL Parcel), labels on
// a packed pick list, and parcels with tracking, returns and customs.
// `/api/carriers/*`, `/api/parcels/*` and `/api/pick-lists/:id/{shipping,labels}`,
// served by the Rust backend only (the Kubernetes editions).
//
// Permissions: `weldstash:carriers:read|create|update|delete` and
// `weldstash:parcels:read|create|update`.
// ============================================================================

export const CARRIER_CODES = ['postnl', 'dhl_parcel_nl'] as const;
export type CarrierCode = (typeof CARRIER_CODES)[number];

export const LABEL_FORMATS = ['pdf_a6', 'pdf_a4', 'zpl'] as const;
export type LabelFormat = (typeof LABEL_FORMATS)[number];

export const CARRIER_CONTRACTS = ['own', 'weldsuite', 'manual'] as const;
export type CarrierContract = (typeof CARRIER_CONTRACTS)[number];

/** Product options the backend names, in the order the label dialog lists them. */
export const SHIPPING_OPTION_KEYS = [
  'signature',
  'ageCheck',
  'noNeighbour',
  'eveningDelivery',
  'saturdayDelivery',
  'insurance',
  'mailbox',
  'servicePoint',
  'returnLabel',
] as const;
export type ShippingOptionKey = (typeof SHIPPING_OPTION_KEYS)[number];

export const CUSTOMS_CONTENT_TYPES = [
  'sale_of_goods',
  'gift',
  'documents',
  'commercial_sample',
  'returned_goods',
  'other',
] as const;
export type CustomsContentType = (typeof CUSTOMS_CONTENT_TYPES)[number];

export const PARCEL_STATUSES = [
  'draft',
  'labelling',
  'label_created',
  'shipped',
  'in_transit',
  'at_service_point',
  'delivered',
  'exception',
  'returned',
  'cancelled',
] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

// ── Addresses ───────────────────────────────────────────────────────────────

const nullableText = z.string().nullable().optional();

export const addressInputSchema = z.object({
  name: nullableText,
  company: nullableText,
  street: nullableText,
  houseNumber: nullableText,
  houseNumberSuffix: nullableText,
  line1: nullableText,
  line2: nullableText,
  postalCode: nullableText,
  city: nullableText,
  state: nullableText,
  country: nullableText,
  email: nullableText,
  phone: nullableText,
});
export type AddressInput = z.infer<typeof addressInputSchema>;

// ── Carriers ────────────────────────────────────────────────────────────────

export interface CarrierCredentialField {
  key: string;
  secret: boolean;
  required: boolean;
}

export interface CarrierCatalogEntry {
  code: CarrierCode;
  name: string;
  website: string;
  credentialFields: CarrierCredentialField[];
  multiCollo: boolean;
  servicePoints: boolean;
  returnLabels: boolean;
  customs: boolean;
  labelFormats: LabelFormat[];
  /** WeldSuite's own carrier contract is offered: labels are paid from the credit wallet. */
  weldsuiteContract: boolean;
}

export const carrierSettingsSchema = z.object({
  sandbox: z.boolean().optional(),
  labelFormat: z.enum(LABEL_FORMATS).optional(),
  defaultProduct: z.string().nullable().optional(),
  senderAddress: addressInputSchema.nullable().optional(),
  returnAddress: addressInputSchema.nullable().optional(),
});
export type CarrierSettings = z.infer<typeof carrierSettingsSchema>;

export const createCarrierSchema = z.object({
  code: z.enum(CARRIER_CODES),
  name: z.string().trim().max(120).optional(),
  contract: z.enum(['own', 'weldsuite']),
  credentials: z.record(z.string()).optional(),
  settings: carrierSettingsSchema.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  /** Save without testing the credentials first. */
  skipTest: z.boolean().optional(),
});
export type CreateCarrierInput = z.infer<typeof createCarrierSchema>;

export const updateCarrierSchema = createCarrierSchema.omit({ code: true }).partial();
export type UpdateCarrierInput = z.infer<typeof updateCarrierSchema>;

export interface CarrierAccount {
  id: string;
  name: string;
  code: CarrierCode;
  carrierName: string;
  contract: CarrierContract;
  isDefault: boolean;
  isActive: boolean;
  accountNumber: string | null;
  settings: CarrierSettings;
  /** Secret values come back masked (`••••abcd`). */
  credentials: Record<string, string>;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CarrierTestResult {
  ok: boolean;
}

export interface CarrierProduct {
  code: string;
  name: string;
  servicePoint: boolean;
  multiCollo: boolean;
  mailbox: boolean;
  returns: boolean;
  options: string[];
}

export interface ListCarrierProductsQuery {
  toCountry?: string;
  business?: boolean;
}

export interface ServicePointAddress {
  company?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  houseNumberSuffix?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface ServicePointOpeningHours {
  /** 1 (Monday) to 7 (Sunday). */
  weekday: number;
  opens: string;
  closes: string;
}

export interface ServicePoint {
  id: string;
  name: string;
  address: ServicePointAddress;
  distanceMeters: number | null;
  latitude: number | null;
  longitude: number | null;
  openingHours: ServicePointOpeningHours[];
  locker: boolean;
  networkId: string | null;
}

export interface ListServicePointsQuery {
  country: string;
  postalCode: string;
  houseNumber?: string;
  limit?: number;
}

export interface ServicePointChoice {
  id: string;
  name: string;
  address: ServicePointAddress;
  networkId: string | null;
}

export const shipmentOptionsSchema = z.object({
  signature: z.boolean().optional(),
  ageCheck: z.boolean().optional(),
  noNeighbour: z.boolean().optional(),
  eveningDelivery: z.boolean().optional(),
  saturdayDelivery: z.boolean().optional(),
  mailbox: z.boolean().optional(),
  insuredValueCents: z.number().int().min(0).optional(),
});
export type ShipmentOptions = z.infer<typeof shipmentOptionsSchema>;

export const pieceInputSchema = z.object({
  weightGrams: z.number().int().min(1),
  lengthCm: z.number().min(0).optional(),
  widthCm: z.number().min(0).optional(),
  heightCm: z.number().min(0).optional(),
});
export type PieceInput = z.infer<typeof pieceInputSchema>;

export const quoteInputSchema = z.object({
  product: z.string().optional(),
  toCountry: z.string().length(2),
  pieces: z.array(z.object({ weightGrams: z.number().int().min(1) })).min(1),
  options: shipmentOptionsSchema.optional(),
  returnLabel: z.boolean().optional(),
});
export type QuoteInput = z.infer<typeof quoteInputSchema>;

export interface CarrierQuote {
  contract: 'own' | 'weldsuite';
  /** Only on WeldSuite's contract. */
  credits: number | null;
  /** `piece` is null for lines of the whole shipment (the return label). */
  lines: Array<{ kind: string; piece: number | null; credits: number }>;
}

// ── Customs ─────────────────────────────────────────────────────────────────

export const customsLineSchema = z.object({
  description: z.string(),
  quantity: z.number().int().min(1),
  valueCents: z.number().int().min(0),
  weightGrams: z.number().int().min(0),
  hsCode: z.string().nullable().optional(),
  originCountry: z.string().nullable().optional(),
});
export type CustomsLine = z.infer<typeof customsLineSchema>;

export const customsInputSchema = z.object({
  content: z.enum(CUSTOMS_CONTENT_TYPES),
  invoiceNumber: z.string().nullable().optional(),
  currency: z.string().length(3),
  lines: z.array(customsLineSchema),
  shippingFeeCents: z.number().int().min(0).optional(),
});
export type CustomsInput = z.infer<typeof customsInputSchema>;

// ── Labels on a pick list ───────────────────────────────────────────────────

export interface PickListShipping {
  pickListId: string;
  status: string;
  orderId: string | null;
  orderNumber: string | null;
  recipient: AddressInput;
  sender: AddressInput;
  suggestedWeightGrams: number | null;
  customsRequired: boolean;
  customs: {
    content: CustomsContentType;
    invoiceNumber: string | null;
    currency: string;
    lines: CustomsLine[];
  };
  servicePoint: ServicePointChoice | null;
  defaultCarrierId: string | null;
  parcels: Parcel[];
}

export const createLabelsSchema = z.object({
  carrierId: z.string().optional(),
  product: z.string().optional(),
  pieces: z.array(pieceInputSchema).min(1),
  options: shipmentOptionsSchema.optional(),
  servicePoint: z
    .object({
      id: z.string(),
      name: z.string(),
      address: z.record(z.string().nullable().optional()),
      networkId: z.string().nullable().optional(),
    })
    .optional(),
  returnLabel: z.boolean().optional(),
  recipient: addressInputSchema.optional(),
  sender: addressInputSchema.optional(),
  customs: customsInputSchema.optional(),
  labelFormat: z.enum(LABEL_FORMATS).optional(),
});
export type CreateLabelsInput = z.infer<typeof createLabelsSchema>;

export interface CreateLabelsResult {
  pickListId: string;
  parcels: Parcel[];
  returnParcel: Parcel | null;
  warnings: string[];
  credits: number | null;
}

export interface VoidLabelsResult {
  pickListId: string;
  voided: number;
  parcelId: string | null;
}

// ── Parcels ─────────────────────────────────────────────────────────────────

export interface ParcelStatusEvent {
  /** Null when the carrier gave no time for the event. */
  at: string | null;
  code: string | null;
  description: string | null;
  location: string | null;
}

export interface ParcelAddress {
  line1?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  houseNumberSuffix?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface Parcel {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ParcelStatus;
  /** Null on a draft parcel the pack step made. */
  statusHistory: ParcelStatusEvent[] | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrierId: string | null;
  carrierName: string | null;
  carrierCode: string | null;
  serviceType: string | null;
  carrierReference: string | null;
  colloNumber: number | null;
  pickListId: string | null;
  shipmentId: string | null;
  orderId: string | null;
  orderNumber: string | null;
  referenceNumber: string | null;
  recipientName: string | null;
  recipientCompany: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  recipientAddress: ParcelAddress | null;
  senderName: string | null;
  senderCompany: string | null;
  senderAddress: ParcelAddress | null;
  /** Kilograms, as text. */
  weight: string | null;
  dimensions: Record<string, unknown> | null;
  servicePoint: { id: string; name: string; carrier?: string | null; address?: ServicePointAddress | null } | null;
  shippingCost: { contract: string; credits: number | null } | null;
  labelUrl: string | null;
  labelFormat: 'pdf' | 'zpl' | null;
  customsFormUrl: string | null;
  customsInfo: Record<string, unknown> | null;
  isReturn: boolean;
  returnForParcelId: string | null;
  returnTrackingNumber: string | null;
  returnLabelUrl: string | null;
  shippedAt: string | null;
  estimatedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  lastScanDate: string | null;
  lastScanLocation: string | null;
  trackingNextCheckAt: string | null;
}

export interface ParcelDetail extends Parcel {
  returnParcels: Parcel[];
}

export interface ListParcelsQuery {
  /** Comma-separated statuses. */
  status?: string;
  carrierId?: string;
  orderId?: string;
  pickListId?: string;
  isReturn?: boolean;
  labelled?: boolean;
  search?: string;
  limit?: number;
  cursor?: string;
}

export const createReturnLabelSchema = z.object({
  weightGrams: z.number().int().min(1).optional(),
  labelFormat: z.enum(LABEL_FORMATS).optional(),
});
export type CreateReturnLabelInput = z.infer<typeof createReturnLabelSchema>;
