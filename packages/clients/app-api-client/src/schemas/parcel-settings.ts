import { z } from 'zod';

export const updateParcelSettingsSchema = z.object({
  defaultCarrier: z.string().optional(),
  defaultServiceType: z.string().optional(),
  autoGenerateLabels: z.boolean().optional(),
  autoSendNotifications: z.boolean().optional(),
  labelFormat: z.enum(['pdf', 'png', 'zpl']).optional(),
  labelSize: z.string().optional(),
  defaultWeight: z
    .object({
      value: z.number(),
      unit: z.string(),
    })
    .optional(),
  defaultDimensions: z
    .object({
      length: z.number(),
      width: z.number(),
      height: z.number(),
      unit: z.string(),
    })
    .optional(),
});

export const updateCarrierCredentialsSchema = z
  .object({
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    accountNumber: z.string().optional(),
  })
  .passthrough();

export type UpdateParcelSettingsInput = z.infer<typeof updateParcelSettingsSchema>;
export type UpdateCarrierCredentialsInput = z.infer<typeof updateCarrierCredentialsSchema>;
