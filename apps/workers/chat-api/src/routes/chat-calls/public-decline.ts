/**
 * POST /public/chat-calls/decline — decline a ring from the phone's native
 * call UI (Android lock-screen notification, iOS CallKit) while the WeldChat
 * app is not running and has no Clerk session to call
 * `/api/chat-calls/:id/decline` with.
 *
 * No Clerk auth: the credential is the ring's signed token
 * (`@weldsuite/chat-domain/call-ring-token`), which names the workspace, the
 * recipient and the call and expires minutes after the ring. Fails closed
 * when `CALL_RING_SECRET` is unset. Idempotent: declining a call that already
 * stopped ringing is a success, so the phone never retries it.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { verifyCallRingToken } from '@weldsuite/chat-domain/call-ring-token';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env } from '../../types';
import { canAccessChannel } from '../../services/chat/channel-access';
import { declineRingingCall } from '../../services/chat/decline-call';

const app = new Hono<{ Bindings: Env }>();

const declineBody = z.object({ token: z.string().min(1).max(2000) });

app.post('/decline', zValidator('json', declineBody), async (c) => {
  const claims = await verifyCallRingToken(c.env.CALL_RING_SECRET, c.req.valid('json').token);
  if (!claims) {
    if (!c.env.CALL_RING_SECRET) console.error('[Chat:Calls] CALL_RING_SECRET is not set; ring declines are rejected');
    return error.unauthorized(c, 'Invalid or expired ring token');
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, claims.orgId);
    const [call] = await db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, claims.callId)).limit(1);
    if (!call) return error.notFound(c, 'Call', claims.callId);
    // The token proves who was rung; still check they belong in the channel
    // now (a member removed mid-ring cannot end the call for the others).
    if (!(await canAccessChannel(db, call.channelId, claims.userId))) {
      return error.forbidden(c, 'You do not have access to this call');
    }

    const declined = await declineRingingCall(db, c.env, claims.orgId, call, claims.userId);
    return success(c, { ok: true, declined });
  } catch (err) {
    console.error('[Chat:Calls] Public ring decline failed:', err);
    return error.internal(c, 'Failed to decline call');
  }
});

export const publicChatCallsRoutes = app;
