/**
 * Feature-flags routes — read-only `/api/feature-flags` surface that exposes
 * the client-visible feature flags for the authenticated user.
 *
 * The platform SPA (and mobile apps) have no Worker of their own, so they read
 * resolved flag values from here. Evaluation happens via the Cloudflare
 * Flagship binding, resolved once per request by the `/api/*`
 * featureFlagsMiddleware and stashed on `c.get('flags')`.
 *
 * Authentication + tenant resolution is enforced by the shared `/api/*`
 * middleware; reading your own flag set needs no object-level permission.
 * Targeting (who sees a flag — by plan / role / %-rollout) is configured in
 * the Flagship dashboard, not here.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { success } from '../../lib/response';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET / — resolve client-exposed feature flags for the current user.
// Add a line per flag the client needs. Keep keys in sync with the Zod
// `featureFlagsResponseSchema` in @weldsuite/app-api-client.
// ============================================================================

app.get('/', async (c) => {
  const flags = c.get('flags');

  // Binding-less local dev (no `flags` resolved, or Flagship unconfigured)
  // falls back to the catalog default — both flags are hidden by default.
  const upgradeButton = flags ? await flags.isOn('upgrade-button') : false;
  const weldflowMoveTask = flags ? await flags.isOn('weldflow-move-task') : false;

  // Never cache flag values — a dashboard flip must take effect immediately.
  c.header('Cache-Control', 'no-store');

  return success(c, {
    'upgrade-button': upgradeButton,
    'weldflow-move-task': weldflowMoveTask,
  });
});

export const featureFlagsRoutes = app;
