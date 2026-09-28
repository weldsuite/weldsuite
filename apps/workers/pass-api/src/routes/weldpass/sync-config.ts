/**
 * Zod schema for a sync target's provider config.
 *
 * Shared by the sync-target routes and credential verification, and mirrors the
 * `WeldPassSyncTargetConfig` union in the schema package — the discriminator
 * means a Pages target cannot be saved with a Worker's fields.
 */

import { z } from 'zod';

export const syncTargetConfigSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('cloudflare_workers'),
    accountId: z.string().min(1).max(100),
    scriptName: z.string().min(1).max(100),
  }),
  z.object({
    provider: z.literal('cloudflare_pages'),
    accountId: z.string().min(1).max(100),
    projectName: z.string().min(1).max(100),
    environment: z.enum(['production', 'preview']),
  }),
  z.object({
    provider: z.literal('vercel'),
    projectId: z.string().min(1).max(100),
    teamId: z.string().min(1).max(100).optional(),
    targets: z
      .array(z.enum(['production', 'preview', 'development']))
      .min(1)
      .max(3),
  }),
]);

export type SyncTargetConfigInput = z.infer<typeof syncTargetConfigSchema>;
