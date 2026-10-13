/**
 * WeldReach overview: GET /api/reach/overview
 *
 * Permission: reach_campaigns:read. Read only; nothing to publish.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { buildOverview } from '../../services/overview';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('reach_campaigns:read'), async (c) => {
  return success(c, await buildOverview(c.get('tenantDb')));
});

export default app;
