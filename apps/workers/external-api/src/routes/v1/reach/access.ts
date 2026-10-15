/**
 * WeldReach access: GET /v1/reach/access
 *
 * Scope: reach_campaigns:read. The workspace's approval status, the limits staff
 * set for it, today's usage and the state of the global sending switch. Read
 * only; nothing to publish.
 */

import { Hono } from 'hono';
import { buildAccessSummary } from '@weldsuite/reach-domain/access';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { success } from '../../../lib/response';
import { reachRequest, reachSendingEnabled } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_campaigns:read'), async (c) => {
  const summary = await buildAccessSummary({
    db: c.get('tenantDb'),
    access: reachRequest(c).access,
    sendingEnabled: await reachSendingEnabled(c),
  });
  return success(c, summary);
});

export default app;
