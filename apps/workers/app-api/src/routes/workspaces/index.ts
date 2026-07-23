/**
 * Workspaces routes — read-only /api/workspaces surface.
 *
 * Lists the workspaces the authenticated user belongs to so mobile + web
 * clients can render a workspace switcher. This is a master-DB read keyed on
 * the caller's `userId`, so — like the dashboard reads — it is gated on
 * authentication + tenant resolution (the `/api/*` Clerk + workspace-db
 * middleware) rather than a single object permission prefix. No mutations,
 * so no entity events.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { success } from '../../lib/response';
import { getMasterDb } from '../../db';
import { listUserWorkspaces } from '../../services/workspaces';

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
    return success(c, []);
  }
});

export const workspacesRoutes = app;
