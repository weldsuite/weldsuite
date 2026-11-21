/**
 * WeldDesk phone: the member's own softphone. Mounted at /api/desk/phone/softphone.
 *
 *   GET    /        conversations:read    { configured, available, registered, sipUsername }
 *   PUT    /        conversations:update  body { available }, same answer
 *   POST   /token   conversations:update  { token, configured, sipUsername }
 *
 * No entity events: a member's own "take calls" switch and credential are not
 * a catalogued entity (there is no desk phone agent type in the events catalog).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { updateDeskSoftphoneSchema } from '@weldsuite/core-api-client/schemas/desk-phone';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import type { TelnyxEnv } from '../../lib/telnyx';
import {
  getSoftphone,
  mintSoftphoneToken,
  setSoftphoneAvailable,
  softphoneConfigured,
} from '../../services/desk-phone-softphone';
import { ringWaitingCalls } from '../../services/desk-phone-ring';

const app = new Hono<{ Bindings: Env & TelnyxEnv; Variables: Variables }>();

app.get('/', requirePermission('conversations:read'), async (c) => {
  return success(c, await getSoftphone(c.env, c.get('tenantDb'), c.get('userId')));
});

app.put('/', requirePermission('conversations:update'), zValidator('json', updateDeskSoftphoneSchema), async (c) => {
  const { available } = c.req.valid('json');
  const db = c.get('tenantDb');
  const before = await getSoftphone(c.env, db, c.get('userId'));
  const state = await setSoftphoneAvailable(c.env, db, c.get('userId'), available);
  // Switched on (it was off, or the member is new): offer them a waiting caller.
  if (available && !before.available) {
    await ringWaitingCalls({ env: c.env, db, workspaceId: c.get('clerkOrgId') });
  }
  return success(c, state);
});

app.post('/token', requirePermission('conversations:update'), async (c) => {
  if (!softphoneConfigured(c.env)) {
    return success(c, { token: null, configured: false, sipUsername: null });
  }
  try {
    const minted = await mintSoftphoneToken(c.env, c.get('tenantDb'), {
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
    });
    return success(c, { token: minted.token, configured: true, sipUsername: minted.sipUsername });
  } catch (err) {
    console.error('[desk-phone] softphone token failed:', err);
    return error.internal(c, 'Failed to generate Voice token');
  }
});

export { app as deskPhoneSoftphoneRoutes };
export default app;
