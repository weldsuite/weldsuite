import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  description: z.string().optional(),
  sku: z.string().max(100).optional(),
  type: z.string().max(30).optional(),
  status: z.string().max(30).optional(),
  price: z.union([z.string(), z.number()]).optional(),
  currency: z.string().max(10).optional(),
  categoryId: z.string().nullish(),
  imageUrl: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProductSchema = createProductSchema.partial();
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
