import { z } from 'zod';

export const createBoxSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  length: z.union([z.string(), z.number()]).optional(),
  width: z.union([z.string(), z.number()]).optional(),
  height: z.union([z.string(), z.number()]).optional(),
  weight: z.union([z.string(), z.number()]).optional(),
  unit: z.string().max(10).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateBoxSchema = createBoxSchema.partial();
export type CreateBoxInput = z.infer<typeof createBoxSchema>;
export type UpdateBoxInput = z.infer<typeof updateBoxSchema>;
