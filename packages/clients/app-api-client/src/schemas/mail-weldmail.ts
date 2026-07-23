/**
 * `/api/mail-weldmail` — reserved addresses on the workspace's shared
 * `{slug}.weldmail.com` subdomain.
 */

import { z } from 'zod';

export const weldMailAddressSchema = z
  .string()
  .min(3, 'Address must be at least 3 characters')
  .max(64, 'Address must be at most 64 characters')
  .regex(
    /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i,
    'Address can only contain letters, numbers, dots, hyphens, and underscores',
  )
  .transform((v) => v.toLowerCase());

export const checkWeldMailAddressSchema = z.object({ address: weldMailAddressSchema });

export const reserveWeldMailAddressSchema = z.object({
  address: weldMailAddressSchema,
  name: z.string().min(1).max(255).optional(),
  displayName: z.string().max(255).optional(),
});

export type CheckWeldMailAddressInput = z.infer<typeof checkWeldMailAddressSchema>;
export type ReserveWeldMailAddressInput = z.infer<typeof reserveWeldMailAddressSchema>;
