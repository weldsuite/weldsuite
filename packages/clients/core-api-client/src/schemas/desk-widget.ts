import { z } from 'zod';

export const deskWidgetBrandingSchema = z.object({
  primaryColor: z.string().max(30).optional(),
  backgroundColor: z.string().max(30).optional(),
  position: z.enum(['right', 'left']).optional(),
});

export const createDeskWidgetSchema = z.object({
  widgetName: z.string().max(255).optional(),
  greeting: z.string().max(500).optional(),
  branding: deskWidgetBrandingSchema.optional(),
  allowedDomains: z.array(z.string().max(255)).optional(),
});

export const updateDeskWidgetSchema = z.object({
  widgetName: z.string().max(255).optional(),
  enabled: z.boolean().optional(),
  greeting: z.string().max(500).nullish(),
  branding: deskWidgetBrandingSchema.optional(),
  allowedDomains: z.array(z.string().max(255)).optional(),
});

export type CreateDeskWidgetInput = z.infer<typeof createDeskWidgetSchema>;
export type UpdateDeskWidgetInput = z.infer<typeof updateDeskWidgetSchema>;
