import { z } from 'zod';

export const calculateRatesSchema = z.object({
  origin: z.object({
    country: z.string(),
    postalCode: z.string(),
  }),
  destination: z.object({
    country: z.string(),
    postalCode: z.string(),
  }),
  parcel: z.object({
    weight: z.object({
      value: z.number().positive(),
      unit: z.string().default('kg'),
    }),
    dimensions: z.object({
      length: z.number().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
      unit: z.string().default('cm'),
    }),
  }),
});

export const selectRateSchema = z.object({
  rateId: z.string(),
  parcelId: z.string(),
});

export type CalculateRatesInput = z.infer<typeof calculateRatesSchema>;
export type SelectRateInput = z.infer<typeof selectRateSchema>;
