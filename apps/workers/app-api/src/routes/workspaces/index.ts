/**
 * Workspaces routes — read-only /api/workspaces surface.
 *
 * Lists the workspaces the authenticated user belongs to so mobile + web
 * clients can render a workspace switcher. This is a master-DB read keyed on
 * the caller's `userId`, so — like the dashboard reads — it is gated on
 * authentication + tenant resolution (the `/api/*` Clerk + workspace-db
 * middleware) rather than a single object permission prefix. No mutations,
 * so no entity events.
 *
 * A failed read answers 500, never an empty list: an empty list means the
 * person belongs to no workspace, and the OIDC session takes it as such.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { listUserWorkspaces } from '@weldsuite/core-domain/workspaces';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET / — workspaces the authenticated user is an active member of
// ============================================================================

app.get('/', async (c) => {
  const userId = c.get('userId');

  try {
    const workspaces = await listUserWorkspaces(getMasterDb(c.env), userId);
    return success(c, workspaces);
  } catch (err) {
    console.error('[app-api/workspaces] list failed:', err);
    return error.internal(c, 'Failed to list workspaces');
  }
});

export const workspacesRoutes = app;
