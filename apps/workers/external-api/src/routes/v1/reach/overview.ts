/**
 * WeldReach overview: GET /v1/reach/overview
 *
 * Scope: reach_campaigns:read. The numbers of the WeldReach dashboard. Read
 * only; nothing to publish.
 */

import { Hono } from 'hono';
import { buildOverview } from '@weldsuite/reach-domain/overview';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { success } from '../../../lib/response';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_campaigns:read'), async (c) => {
  return success(c, await buildOverview(c.get('tenantDb')));
});

export default app;
