/**
 * WeldDesk phone: callers waiting for an agent. Mounted at /api/desk/phone/queue.
 *
 *   GET  /                    conversations:read    waiting callers, oldest first
 *   POST /:callId/pickup      conversations:update  ring the calling member for that call
 *
 * Waiting = queued, no agent yet, not ended, no outcome. No entity events:
 * the waiting set is announced on the realtime topic `desk_phone_queue`.
 */

import { Hono } from 'hono';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { schema } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import type { TelnyxEnv } from '../../lib/telnyx';
import { waitingCallsCondition } from '../../lib/desk-phone-realtime';
import { loadRouteForNumber, resolveRouteOptions } from '../../lib/desk-phone-options';
import { conversationCallerName, isWaitingCall, loadCall, ringMember } from '../../services/desk-phone-ring';

const app = new Hono<{ Bindings: Env & TelnyxEnv; Variables: Variables }>();

app.get('/', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const calls = schema.voipCalls;
  const rows = await db
    .select({
      callId: calls.id,
      conversationId: calls.deskConversationId,
      fromNumber: calls.fromNumber,
      departmentId: calls.departmentId,
      queueEnteredAt: calls.queueEnteredAt,
      name: schema.deskConversations.name,
    })
    .from(calls)
    .leftJoin(schema.deskConversations, eq(schema.deskConversations.id, calls.deskConversationId))
    .where(waitingCallsCondition())
    .orderBy(asc(calls.queueEnteredAt), asc(calls.id));

  const ringing = new Set<string>();
  if (rows.length > 0) {
    const legs = await db
      .select({ callId: schema.deskPhoneCallLegs.callId })
      .from(schema.deskPhoneCallLegs)
      .where(
        and(
          inArray(
            schema.deskPhoneCallLegs.callId,
            rows.map((r) => r.callId),
          ),
          eq(schema.deskPhoneCallLegs.status, 'ringing'),
        ),
      );
    for (const leg of legs) ringing.add(leg.callId);
  }

  return success(
    c,
    rows.map((r) => ({
      callId: r.callId,
      conversationId: r.conversationId,
      fromNumber: r.fromNumber,
      callerName: conversationCallerName(r.name, r.fromNumber),
      departmentId: r.departmentId,
      waitingSince: (r.queueEnteredAt ?? new Date(0)).toISOString(),
      ringing: ringing.has(r.callId),
    })),
  );
});

app.post('/:callId/pickup', requirePermission('conversations:update'), async (c) => {
  const db = c.get('tenantDb');
  const callId = c.req.param('callId');
  const userId = c.get('userId');

  const call = await loadCall(db, callId);
  if (!call) return error.notFound(c, 'Call', callId);
  if (!isWaitingCall(call)) return error.conflict(c, 'The call is no longer waiting');
  if (!call.providerCallId) return error.conflict(c, 'The call cannot be picked up yet');

  const [agent] = await db
    .select({ sipUsername: schema.deskPhoneAgents.sipUsername })
    .from(schema.deskPhoneAgents)
    .where(eq(schema.deskPhoneAgents.userId, userId))
    .limit(1);
  if (!agent?.sipUsername) return error.conflict(c, 'You have no softphone credential yet');
  if (!c.env.TELNYX_API_KEY || !c.env.TELNYX_CONNECTION_ID) {
    return error.badRequest(c, 'Phone service is not activated');
  }

  const options = resolveRouteOptions(await loadRouteForNumber(db, call.toNumber));
  const result = await ringMember(
    { env: c.env, db, workspaceId: c.get('clerkOrgId') },
    call,
    { userId, sipUsername: agent.sipUsername },
    options.ringSeconds,
  );
  if (result === 'failed') return error.badGateway(c, 'Could not ring your softphone');
  return success(c, { callId, ringing: true as const });
});

export { app as deskPhoneQueueRoutes };
export default app;
