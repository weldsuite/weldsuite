import { z } from 'zod';

export const addCreditsSchema = z.object({
  amount: z.number().positive(),
  paymentMethod: z.string().optional(),
  paymentReference: z.string().optional(),
  description: z.string().optional(),
});

export const deductCreditsSchema = z.object({
  amount: z.number().positive(),
  referenceType: z.string().optional(),
  referenceId: z.string().nullish(),
  description: z.string().optional(),
});

export const estimateCostSchema = z.object({
  carrierId: z.string(),
  fromCountry: z.string(),
  toCountry: z.string(),
  weight: z.coerce.number().positive(),
  serviceType: z.string().optional(),
});

export type AddCreditsInput = z.infer<typeof addCreditsSchema>;
export type DeductCreditsInput = z.infer<typeof deductCreditsSchema>;
export type EstimateCostInput = z.infer<typeof estimateCostSchema>;
