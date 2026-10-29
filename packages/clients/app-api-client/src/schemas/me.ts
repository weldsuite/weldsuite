/**
 * `/api/me/permissions` — the caller's effective permissions for the active
 * workspace (`apps/workers/app-api/src/routes/me/index.ts`). First-party
 * clients gate their UI on it; the server still enforces every request.
 */

import { z } from 'zod';

export const myPermissionsSchema = z.object({
  permissions: z.array(z.string()),
  /** Explicit per-member denies; a deny wins over any grant. */
  denies: z.array(z.string()).optional(),
  /** Whether the server enforces per-app permissions (else any-app). */
  appEnforced: z.boolean().optional(),
  role: z.string(),
  roleId: z.string().nullable(),
  isOwner: z.boolean(),
});

export type MyPermissions = z.infer<typeof myPermissionsSchema>;
