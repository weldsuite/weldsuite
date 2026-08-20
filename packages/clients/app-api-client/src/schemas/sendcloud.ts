import { z } from 'zod';

export const sendcloudConnectSchema = z.object({
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
});

export const sendcloudSenderPatchSchema = z.object({
  id: z.number().int(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export const sendcloudMethodPatchSchema = z.object({
  code: z.string().min(1),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export const updateSendcloudSettingsSchema = z.object({
  senders: z.array(sendcloudSenderPatchSchema).optional(),
  methods: z.array(sendcloudMethodPatchSchema).optional(),
});

export const shipPickListSchema = z.object({
  senderId: z.number().int().positive(),
  shippingOptionCode: z.string().min(1),
  weightKg: z.number().positive(),
});

export type SendcloudConnectInput = z.infer<typeof sendcloudConnectSchema>;
export type UpdateSendcloudSettingsInput = z.infer<typeof updateSendcloudSettingsSchema>;
export type ShipPickListInput = z.infer<typeof shipPickListSchema>;

export interface SendcloudSenderPublic {
  id: number;
  name: string;
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  houseNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string | null;
  enabled: boolean;
  isDefault: boolean;
}

export interface SendcloudMethodPublic {
  code: string;
  name: string;
  carrierCode?: string | null;
  carrierName?: string | null;
  minWeightKg?: number | null;
  maxWeightKg?: number | null;
  enabled: boolean;
  isDefault: boolean;
}

export interface SendcloudSettingsPublic {
  connected: boolean;
  publicKeyMasked?: string | null;
  accountName?: string | null;
  lastSyncedAt?: string | null;
  senders: SendcloudSenderPublic[];
  methods: SendcloudMethodPublic[];
}

export interface ShipPickListResult {
  id: string;
  status: string;
  shipmentId?: string | null;
  parcelId?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  labelUrl?: string | null;
  labelPdfBase64?: string | null;
  carrierName?: string | null;
  shippingOptionCode?: string | null;
}
