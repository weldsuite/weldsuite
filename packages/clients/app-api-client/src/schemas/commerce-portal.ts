import { z } from 'zod';

export const commercePortalAccessStatusSchema = z.enum(['invited', 'active', 'revoked']);

export const updateCommercePortalSettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  displayName: z.string().max(255).nullable().optional(),
  logo: z.string().max(500).nullable().optional(),
  primaryColor: z.string().max(20).nullable().optional(),
  accentColor: z.string().max(20).nullable().optional(),
});

export const inviteCommercePortalAccessSchema = z.object({
  personId: z.string().min(1),
  companyId: z.string().min(1),
});

export const commercePortalAuthRequestSchema = z.object({
  email: z.string().email(),
  slug: z.string().min(1).optional(),
});

export const commercePortalAuthVerifySchema = z.object({
  token: z.string().min(1).optional(),
  otp: z.string().min(4).max(12).optional(),
  accessId: z.string().min(1).optional(),
}).refine((v) => Boolean(v.token || v.otp), {
  message: 'token or otp is required',
});

export const commercePortalSelectCompanySchema = z.object({
  pickerToken: z.string().min(1),
  companyId: z.string().min(1),
});

export const commercePortalPlaceOrderItemSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  quantity: z.number().int().positive().max(10_000),
});

const portalAddressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
}).optional();

export const commercePortalPlaceOrderSchema = z.object({
  items: z.array(commercePortalPlaceOrderItemSchema).min(1).max(200),
  customerNote: z.string().max(4000).optional(),
  purchaseOrderNumber: z.string().max(100).optional(),
  shippingAddress: portalAddressSchema,
});

export const commercePortalCreateReturnItemSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().min(1),
  sku: z.string().optional(),
  quantity: z.number().int().positive(),
  reason: z.string().optional(),
  condition: z.enum(['new', 'opened', 'damaged', 'defective']).optional(),
});

export const commercePortalCreateReturnSchema = z.object({
  originalOrderId: z.string().min(1),
  reason: z.string().max(100).optional(),
  reasonDetails: z.string().max(4000).optional(),
  items: z.array(commercePortalCreateReturnItemSchema).min(1),
  customerNotes: z.string().max(4000).optional(),
});

export type UpdateCommercePortalSettingsInput = z.infer<typeof updateCommercePortalSettingsSchema>;
export type InviteCommercePortalAccessInput = z.infer<typeof inviteCommercePortalAccessSchema>;
export type CommercePortalAuthRequestInput = z.infer<typeof commercePortalAuthRequestSchema>;
export type CommercePortalAuthVerifyInput = z.infer<typeof commercePortalAuthVerifySchema>;
export type CommercePortalSelectCompanyInput = z.infer<typeof commercePortalSelectCompanySchema>;
export type CommercePortalPlaceOrderInput = z.infer<typeof commercePortalPlaceOrderSchema>;
export type CommercePortalCreateReturnInput = z.infer<typeof commercePortalCreateReturnSchema>;
