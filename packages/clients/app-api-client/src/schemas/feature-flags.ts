/**
 * `/api/feature-flags` — client-exposed feature flags for the current user,
 * resolved server-side via Cloudflare Flagship. One boolean per flag the
 * client needs; keep keys in sync with the route handler in
 * `apps/workers/app-api/src/routes/feature-flags/index.ts` and the catalog in
 * `@weldsuite/feature-flags`.
 */

import { z } from 'zod';

export const featureFlagsResponseSchema = z.object({
  /** Sidebar "Upgrade" button in the platform module sidebar. */
  'upgrade-button': z.boolean(),
  /** WeldFlow "Move to project" action (task list row + detail panel). */
  'weldflow-move-task': z.boolean(),
});

export type FeatureFlagsResponse = z.infer<typeof featureFlagsResponseSchema>;
