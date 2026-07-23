/**
 * WeldChat Call Routes (app-api).
 *
 * Voice/video call lifecycle management via Cloudflare RealtimeKit.
 * The backend creates meetings and participant tokens — the client SDK
 * (@cloudflare/realtimekit) handles all WebRTC.
 *
 * Ported from the obsolete api-worker (src/routes/chat/calls.ts). Imports the
 * RealtimeKit client directly from @weldsuite/cloudflare-realtime and uses the
 * app-api call publisher + call-lifecycle services.
 *
 * Mounted at /api/chat-calls. The platform/mobile clients call /chat-calls/*
 * (the app-api client prepends /api) and rely on the `call_incoming` event on
 * `chat.user.${userId}` carrying { callId, channelId, callType, callerName,
 * callerAvatar }.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, or, inArray } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createMeeting, addParticipant, endMeeting } from '@weldsuite/cloudflare-realtime';
import { sendMissedCallNotification, sendIncomingCallNotification } from '@weldsuite/notifications';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Env, Variables } from '../../types';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { success, error } from '../../lib/response';
import {
  publishChatCallStarted,
  publishChatCallEnded,
  publishChatCallParticipantJoined,
  publishChatCallParticipantLeft,
  publishChatCallIncoming,
  broadcastChatCallToMembers,
} from '../../services/realtime/weldchat-call-publisher';
import { endChatCall } from '../../services/chat/call-lifecycle';
import { canAccessChannel } from '../../services/chat/channel-access';
import {
  dedupeParticipants,
  activeParticipantCount,
  upsertParticipant,
  evictRtkSessions,
  leaveOtherActiveCalls,
} from '../../services/chat/call-participants';

// ============================================================================
// Schemas
// ============================================================================

const startCallSchema = z.object({
  channelId: z.string().min(1),
  callType: z.enum(['voice', 'video']).default('voice'),
});

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST / - Start a call in a channel
 */
app.post('/', requirePermission('channels:create'), zValidator('json', startCallSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { chatCalls, chatChannels, chatChannelMembers, chatMessages, workspaceMembers } = schema;

    // Verify user is a member of the channel
    const [membership] = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.channelId, data.channelId),
          eq(chatChannelMembers.userId, userId)
        )
      )
      .limit(1);

    if (!membership) {
      return error.forbidden(c, 'You are not a member of this channel');
    }

    // Check channel-level call permissions
    const [channel] = await db
      .select({
        voiceCallsEnabled: chatChannels.voiceCallsEnabled,
        videoCallsEnabled: chatChannels.videoCallsEnabled,
      })
      .from(chatChannels)
      .where(eq(chatChannels.id, data.channelId))
      .limit(1);

    if (data.callType === 'voice' && channel && !channel.voiceCallsEnabled) {
      return error.forbidden(c, 'Voice calls are disabled in this channel');
    }
    if (data.callType === 'video' && channel && !channel.videoCallsEnabled) {
      return error.forbidden(c, 'Video calls are disabled in this channel');
    }

    // Check no active call in this channel
    const [activeCall] = await db
      .select({ id: chatCalls.id })
      .from(chatCalls)
      .where(
        and(
          eq(chatCalls.channelId, data.channelId),
          or(eq(chatCalls.status, 'ringing'), eq(chatCalls.status, 'active'))
        )
      )
      .limit(1);

    if (activeCall) {
      // Check if this is a stale call that should be auto-ended
      const [fullCall] = await db
        .select()
        .from(chatCalls)
        .where(eq(chatCalls.id, activeCall.id))
        .limit(1);

      if (fullCall) {
        const participants: ChatCallParticipant[] = fullCall.participants ?? [];
        const activeParticipants = participants.filter((p) => !p.leftAt);
        const age = Date.now() - new Date(fullCall.createdAt).getTime();
        const isStale =
          (activeParticipants.length === 0 && age > 60_000) ||
          (fullCall.status === 'ringing' && age > 60_000);

        if (isStale) {
          try { await endChatCall(c.get('tenantDb'), c.env, orgId, fullCall.id, fullCall, fullCall.initiatorId); } catch { /* best effort */ }
        } else {
          return error.conflict(c, 'A call is already active in this channel');
        }
      } else {
        return error.conflict(c, 'A call is already active in this channel');
      }
    }

    // Get initiator info
    const [author] = await db
      .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);

    const callId = generateId('call');
    const now = new Date();
    const initiatorName = author?.name ?? 'Unknown';
    const callLabel = data.callType === 'video' ? 'video call' : 'voice call';

    // Create RealtimeKit meeting
    const rtkMeeting = await createMeeting(c.env, `${initiatorName}'s ${callLabel}`);

    // Store KV mapping for webhook resolution
    await c.env.WORKSPACE_CACHE.put(
      `rtk-meeting:${rtkMeeting.id}`,
      JSON.stringify({ orgId: c.get('orgId'), type: 'call', callId, channelId: data.channelId }),
      { expirationTtl: 86400 },
    );

    // Insert call record
    await db.insert(chatCalls).values({
      id: callId,
      channelId: data.channelId,
      callType: data.callType,
      status: 'ringing',
      cfAppId: rtkMeeting.id,
      initiatorId: userId,
      initiatorName,
      participants: [],
      maxParticipants: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Post system message
    const msgId = generateId('msg');
    await db.insert(chatMessages).values({
      id: msgId,
      channelId: data.channelId,
      authorId: userId,
      authorName: initiatorName,
      authorAvatar: author?.picture ?? null,
      content: `${initiatorName} started a ${callLabel}`,
      type: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await db.update(chatCalls).set({ startMessageId: msgId }).where(eq(chatCalls.id, callId));

    // Publish realtime events (non-blocking)
    try {
      await publishChatCallStarted(c.env, data.channelId, {
        callId,
        callType: data.callType,
        initiatorId: userId,
        initiatorName,
      });
      await broadcastChatCallToMembers(c.env, db, orgId, data.channelId, 'started', {
        callId,
        callType: data.callType,
      });

      // For DM channels (incl. group DMs), send incoming call notification to
      // every other member.
      const [channel] = await db
        .select({ type: chatChannels.type })
        .from(chatChannels)
        .where(eq(chatChannels.id, data.channelId))
        .limit(1);

      if (channel?.type === 'dm') {
        const members = await db
          .select({ userId: chatChannelMembers.userId })
          .from(chatChannelMembers)
          .where(eq(chatChannelMembers.channelId, data.channelId));

        for (const member of members) {
          if (member.userId !== userId) {
            await publishChatCallIncoming(c.env, orgId, member.userId, {
              callId,
              channelId: data.channelId,
              callType: data.callType,
              callerName: initiatorName,
              callerAvatar: author?.picture ?? undefined,
            });
            // Push notification (non-blocking) — never block the response.
            try {
              await sendIncomingCallNotification({
                db,
                env: c.env,
                workspaceId: orgId,
                recipientUserId: member.userId,
                callerUserId: userId,
                callerName: initiatorName,
                channelId: data.channelId,
                callId,
                callType: data.callType,
              });
            } catch (e) {
              console.error('[Chat:Calls] Incoming-call notification failed:', e);
            }
          }
        }
      }
    } catch (e) {
      console.error('[Chat:Calls] Realtime publish failed:', e);
    }

    return success(c, { callId, status: 'ringing', meetingId: rtkMeeting.id }, 201);
  } catch (err) {
    console.error('[Chat:Calls] Failed to start call:', err);
    return error.internal(c, 'Failed to start call');
  }
});

/**
 * POST /start-and-join - Start a call AND join in one request
 *
 * Combines the create + join flow into a single round-trip.
 * Internally parallelises the RTK createMeeting + addParticipant calls
 * and fires notifications without blocking the response.
 */
app.post('/start-and-join', requirePermission('channels:create'), zValidator('json', startCallSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { chatCalls, chatChannels, chatChannelMembers, chatMessages, workspaceMembers } = schema;

    // Run membership check + channel permissions + active call check + user info in parallel
    const [membershipResult, channelResult, activeCallResult, authorResult] = await Promise.all([
      db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(and(eq(chatChannelMembers.channelId, data.channelId), eq(chatChannelMembers.userId, userId)))
        .limit(1),
      db
        .select({ voiceCallsEnabled: chatChannels.voiceCallsEnabled, videoCallsEnabled: chatChannels.videoCallsEnabled, type: chatChannels.type })
        .from(chatChannels)
        .where(eq(chatChannels.id, data.channelId))
        .limit(1),
      db
        .select()
        .from(chatCalls)
        .where(and(eq(chatCalls.channelId, data.channelId), or(eq(chatCalls.status, 'ringing'), eq(chatCalls.status, 'active'))))
        .limit(1),
      db
        .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1),
    ]);

    if (!membershipResult[0]) {
      return error.forbidden(c, 'You are not a member of this channel');
    }

    const channel = channelResult[0];
    if (data.callType === 'voice' && channel && !channel.voiceCallsEnabled) {
      return error.forbidden(c, 'Voice calls are disabled in this channel');
    }
    if (data.callType === 'video' && channel && !channel.videoCallsEnabled) {
      return error.forbidden(c, 'Video calls are disabled in this channel');
    }

    const existingCall = activeCallResult[0];
    if (existingCall) {
      const participants: ChatCallParticipant[] = existingCall.participants ?? [];
      const activeParticipants = participants.filter((p) => !p.leftAt);
      const age = Date.now() - new Date(existingCall.createdAt).getTime();
      const isStale =
        (activeParticipants.length === 0 && age > 60_000) ||
        (existingCall.status === 'ringing' && age > 60_000);

      if (isStale) {
        try { await endChatCall(db, c.env, orgId, existingCall.id, existingCall, existingCall.initiatorId); } catch { /* best effort */ }
      } else if (existingCall.cfAppId) {
        // A call is already active in this channel — JOIN it instead of
        // erroring, so the caller "just joins" the ongoing call. The
        // requested callType is ignored: you join the call that exists.
        const joinAuthor = authorResult[0];
        const joinName = joinAuthor?.name ?? 'Unknown';
        const rtkParticipant = await addParticipant(c.env, existingCall.cfAppId, {
          name: joinName,
          customParticipantId: userId,
          picture: joinAuthor?.picture ?? undefined,
        });
        const joinParticipant: ChatCallParticipant = {
          userId,
          userName: joinName,
          userAvatar: joinAuthor?.picture ?? undefined,
          joinedAt: new Date().toISOString(),
          cfSessionId: rtkParticipant.id,
          hasAudio: false,
          hasVideo: false,
          hasScreenShare: false,
        };
        // Idempotent on userId; surfaces stale sessions to evict.
        const { next: merged, staleSessionIds } = upsertParticipant(existingCall.participants, joinParticipant);
        c.executionCtx.waitUntil(
          Promise.all([
            db.update(chatCalls).set({
              participants: merged,
              maxParticipants: Math.max(existingCall.maxParticipants ?? 0, merged.filter((p) => !p.leftAt).length),
              updatedAt: new Date(),
            }).where(eq(chatCalls.id, existingCall.id)),
            evictRtkSessions(c.env, existingCall.cfAppId, staleSessionIds),
            leaveOtherActiveCalls(db, c.env, orgId, userId, existingCall.id),
            publishChatCallParticipantJoined(c.env, data.channelId, {
              callId: existingCall.id,
              userId,
              userName: joinName,
              userAvatar: joinAuthor?.picture ?? undefined,
              cfSessionId: rtkParticipant.id,
            }).catch(() => {}),
          ]).catch((e) => console.error('[Chat:Calls] Background join-existing tasks failed:', e)),
        );
        return success(c, {
          callId: existingCall.id,
          authToken: rtkParticipant.token,
          participants: merged,
          callType: existingCall.callType,
        }, 200);
      } else {
        return error.conflict(c, 'A call is already active in this channel');
      }
    }

    const author = authorResult[0];
    const callId = generateId('call');
    const now = new Date();
    const initiatorName = author?.name ?? 'Unknown';
    const callLabel = data.callType === 'video' ? 'video call' : 'voice call';

    // Create RTK meeting — this is the main latency source
    const rtkMeeting = await createMeeting(c.env, `${initiatorName}'s ${callLabel}`);

    // Now add participant to get auth token, while also writing to DB in parallel
    const participant: ChatCallParticipant = {
      userId,
      userName: initiatorName,
      userAvatar: author?.picture ?? undefined,
      joinedAt: now.toISOString(),
      cfSessionId: '', // filled after addParticipant
      hasAudio: false,
      hasVideo: false,
      hasScreenShare: false,
    };

    const msgId = generateId('msg');

    const [rtkParticipant] = await Promise.all([
      // Get participant auth token from Cloudflare
      addParticipant(c.env, rtkMeeting.id, {
        name: initiatorName,
        customParticipantId: userId,
        picture: author?.picture ?? undefined,
      }),
      // Insert call record + system message + KV mapping in parallel with addParticipant
      (async () => {
        await Promise.all([
          db.insert(chatCalls).values({
            id: callId,
            channelId: data.channelId,
            callType: data.callType,
            status: 'active',
            cfAppId: rtkMeeting.id,
            initiatorId: userId,
            initiatorName,
            participants: [participant],
            maxParticipants: 1,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(chatMessages).values({
            id: msgId,
            channelId: data.channelId,
            authorId: userId,
            authorName: initiatorName,
            authorAvatar: author?.picture ?? null,
            content: `${initiatorName} started a ${callLabel}`,
            type: 'system',
            createdAt: now,
            updatedAt: now,
          }),
          c.env.WORKSPACE_CACHE.put(
            `rtk-meeting:${rtkMeeting.id}`,
            JSON.stringify({ orgId, type: 'call', callId, channelId: data.channelId }),
            { expirationTtl: 86400 },
          ),
        ]);
      })(),
    ]);

    // Update the participant's cfSessionId and link the system message (non-blocking)
    participant.cfSessionId = rtkParticipant.id;
    c.executionCtx.waitUntil(
      Promise.all([
        // Re-read before writing so a racing /join isn't clobbered, then upsert
        // self (idempotent on userId). Also enforce one-call-at-a-time.
        (async () => {
          const [fresh] = await db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1);
          const { next } = upsertParticipant(fresh?.participants, participant);
          await db.update(chatCalls).set({
            participants: next,
            maxParticipants: Math.max(fresh?.maxParticipants ?? 0, next.filter((p) => !p.leftAt).length),
            startMessageId: msgId,
          }).where(eq(chatCalls.id, callId));
          await leaveOtherActiveCalls(db, c.env, orgId, userId, callId);
        })(),
        // Publish realtime events
        publishChatCallStarted(c.env, data.channelId, {
          callId,
          callType: data.callType,
          initiatorId: userId,
          initiatorName,
        }).catch(() => {}),
        broadcastChatCallToMembers(c.env, db, orgId, data.channelId, 'started', {
          callId,
          callType: data.callType,
        }).catch(() => {}),
        publishChatCallParticipantJoined(c.env, data.channelId, {
          callId,
          userId,
          userName: initiatorName,
          userAvatar: author?.picture ?? undefined,
          cfSessionId: rtkParticipant.id,
        }).catch(() => {}),
        // DM incoming call notifications (realtime + push)
        (async () => {
          if (channel?.type === 'dm') {
            const members = await db
              .select({ userId: chatChannelMembers.userId })
              .from(chatChannelMembers)
              .where(eq(chatChannelMembers.channelId, data.channelId));
            await Promise.all(
              members
                .filter((m) => m.userId !== userId)
                .flatMap((m) => [
                  publishChatCallIncoming(c.env, orgId, m.userId, {
                    callId,
                    channelId: data.channelId,
                    callType: data.callType,
                    callerName: initiatorName,
                    callerAvatar: author?.picture ?? undefined,
                  }).catch(() => {}),
                  sendIncomingCallNotification({
                    db,
                    env: c.env,
                    workspaceId: orgId,
                    recipientUserId: m.userId,
                    callerUserId: userId,
                    callerName: initiatorName,
                    channelId: data.channelId,
                    callId,
                    callType: data.callType,
                  }).catch(() => {}),
                ]),
            );
          }
        })(),
      ]).catch((e) => console.error('[Chat:Calls] Background tasks failed:', e)),
    );

    return success(c, {
      callId,
      authToken: rtkParticipant.token,
      participants: [participant],
      callType: data.callType,
    }, 201);
  } catch (err) {
    console.error('[Chat:Calls] Failed to start-and-join call:', err);
    return error.internal(c, 'Failed to start call');
  }
});

/**
 * POST /:callId/join - Join a call (get RealtimeKit auth token)
 */
app.post('/:callId/join', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const callId = c.req.param('callId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls, workspaceMembers } = schema;

    // Fetch call + user info in parallel
    const [callResult, authorResult] = await Promise.all([
      db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1),
      db.select({ name: workspaceMembers.name, picture: workspaceMembers.picture }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).limit(1),
    ]);

    const [call] = callResult;
    if (!call) return error.notFound(c, 'Call', callId);
    // Membership boundary: you may only join a call in a channel you can access
    // (public, or one you're a member of) — never an arbitrary private/DM call
    // by guessing its callId.
    if (!(await canAccessChannel(db, call.channelId, userId))) {
      return error.forbidden(c, 'You do not have access to this call');
    }
    if (call.status !== 'ringing' && call.status !== 'active') {
      return error.badRequest(c, 'Call is not joinable');
    }
    if (!call.cfAppId) {
      return error.internal(c, 'Call has no meeting ID');
    }

    const author = authorResult[0];
    const userName = author?.name ?? 'Unknown';

    // Add participant to RealtimeKit meeting → get auth token
    const rtkParticipant = await addParticipant(c.env, call.cfAppId, {
      name: userName,
      customParticipantId: userId,
      picture: author?.picture ?? undefined,
    });

    const participant: ChatCallParticipant = {
      userId,
      userName,
      userAvatar: author?.picture ?? undefined,
      joinedAt: new Date().toISOString(),
      cfSessionId: rtkParticipant.id,
      hasAudio: false,
      hasVideo: false,
      hasScreenShare: false,
    };

    // Idempotent on userId — the user can never appear twice. Surfaces any
    // previous live session so we can evict the stale duplicate tile.
    const { next: participants, staleSessionIds } = upsertParticipant(call.participants, participant);

    const now = new Date();
    const updates: Record<string, unknown> = {
      participants,
      maxParticipants: Math.max(call.maxParticipants ?? 0, participants.filter((p) => !p.leftAt).length),
      updatedAt: now,
    };

    if (call.status === 'ringing') {
      updates.status = 'active';
      updates.startedAt = now;
    }

    // Defer DB update + realtime publish + invariant enforcement — don't block
    // the response. Evicting the user's stale session in THIS call kills any
    // duplicate "me" tile; leaving other calls enforces one-call-at-a-time.
    c.executionCtx.waitUntil(
      Promise.all([
        db.update(chatCalls).set(updates).where(eq(chatCalls.id, callId)),
        evictRtkSessions(c.env, call.cfAppId, staleSessionIds),
        leaveOtherActiveCalls(db, c.env, orgId, userId, callId),
        publishChatCallParticipantJoined(c.env, call.channelId, {
          callId,
          userId,
          userName,
          userAvatar: author?.picture ?? undefined,
          cfSessionId: rtkParticipant.id,
        }).catch((e) => console.error('[Chat:Calls] Realtime publish failed:', e)),
      ]).catch((e) => console.error('[Chat:Calls] Background join tasks failed:', e)),
    );

    return success(c, {
      callId,
      authToken: rtkParticipant.token,
      participants,
    });
  } catch (err: any) {
    console.error('[Chat:Calls] Failed to join call:', err?.message ?? err, err?.stack ?? '');
    return error.internal(c, 'Failed to join call');
  }
});

/**
 * POST /:callId/leave - Leave a call
 */
app.post('/:callId/leave', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const callId = c.req.param('callId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls } = schema;

    const [call] = await db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1);
    if (!call) return error.notFound(c, 'Call', callId);
    if (!(await canAccessChannel(db, call.channelId, userId))) {
      return error.forbidden(c, 'You do not have access to this call');
    }

    const now = new Date();
    const participants = dedupeParticipants(call.participants).map((p) =>
      p.userId === userId ? { ...p, leftAt: p.leftAt ?? now.toISOString() } : p,
    );

    const activeParticipants = participants.filter((p) => !p.leftAt);

    await db.update(chatCalls).set({
      participants,
      updatedAt: now,
    }).where(eq(chatCalls.id, callId));

    try {
      await publishChatCallParticipantLeft(c.env, call.channelId, { callId, userId });
    } catch (e) {
      console.error('[Chat:Calls] Realtime publish failed:', e);
    }

    // Auto-end call if no active participants remain (skip if already ended —
    // e.g. the one-call-at-a-time eviction tore it down first).
    if (activeParticipants.length === 0 && (call.status === 'active' || call.status === 'ringing')) {
      await endChatCall(c.get('tenantDb'), c.env, orgId, callId, call, userId);
    }

    return success(c, { ok: true });
  } catch (err) {
    console.error('[Chat:Calls] Failed to leave call:', err);
    return error.internal(c, 'Failed to leave call');
  }
});

/**
 * POST /:callId/end - End a call
 */
app.post('/:callId/end', requirePermission('channels:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const callId = c.req.param('callId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls } = schema;

    const [call] = await db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1);
    if (!call) return error.notFound(c, 'Call', callId);
    if (!(await canAccessChannel(db, call.channelId, userId))) {
      return error.forbidden(c, 'You do not have access to this call');
    }

    await endChatCall(c.get('tenantDb'), c.env, orgId, callId, call, userId);

    return success(c, { ok: true });
  } catch (err) {
    console.error('[Chat:Calls] Failed to end call:', err);
    return error.internal(c, 'Failed to end call');
  }
});

/**
 * POST /:callId/decline - Decline an incoming 1:1 call
 */
app.post('/:callId/decline', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const callId = c.req.param('callId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls, chatMessages } = schema;

    const [call] = await db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1);
    if (!call) return error.notFound(c, 'Call', callId);
    if (!(await canAccessChannel(db, call.channelId, c.get('userId')))) {
      return error.forbidden(c, 'You do not have access to this call');
    }
    if (call.status !== 'ringing') return error.badRequest(c, 'Call is not ringing');

    const now = new Date();
    await db.update(chatCalls).set({
      status: 'declined',
      endedAt: now,
      updatedAt: now,
    }).where(eq(chatCalls.id, callId));

    // End the RTK meeting
    if (call.cfAppId) {
      try { await endMeeting(c.env, call.cfAppId); } catch { /* best effort */ }
    }

    const msgId = generateId('msg');
    await db.insert(chatMessages).values({
      id: msgId,
      channelId: call.channelId,
      authorId: call.initiatorId,
      authorName: call.initiatorName,
      content: 'Missed call',
      type: 'system',
      createdAt: now,
      updatedAt: now,
    });

    try {
      await publishChatCallEnded(c.env, call.channelId, { callId, duration: 0, endedBy: c.get('userId') });
      await broadcastChatCallToMembers(c.env, c.get('tenantDb'), orgId, call.channelId, 'ended', { callId });
    } catch (e) {
      console.error('[Chat:Calls] Realtime publish failed:', e);
    }

    // Send missed-call notification to the recipient (they got called but declined)
    const declinerId = c.get('userId');
    if (declinerId !== call.initiatorId) {
      try {
        const [initiatorInfo] = await db
          .select({ name: schema.workspaceMembers.name })
          .from(schema.workspaceMembers)
          .where(eq(schema.workspaceMembers.userId, call.initiatorId))
          .limit(1);
        await sendMissedCallNotification({
          db,
          env: c.env,
          workspaceId: orgId,
          recipientUserId: declinerId,
          callerUserId: call.initiatorId,
          callerName: initiatorInfo?.name ?? call.initiatorName,
          channelId: call.channelId,
          callId,
          callType: call.callType,
        });
      } catch (e) {
        console.error('[Chat:Calls] Missed-call notification failed:', e);
      }
    }

    return success(c, { ok: true });
  } catch (err) {
    console.error('[Chat:Calls] Failed to decline call:', err);
    return error.internal(c, 'Failed to decline call');
  }
});

/**
 * GET /active - Get all active calls across channels the user is a member of
 *
 * Single-request replacement for per-channel polling. Used by the WeldChat
 * sidebar to show call indicators. Push updates (CALL_STARTED / CALL_ENDED
 * on the user's `chat.user.${userId}` topic) keep the cache in sync.
 *
 * Registered before `/:callId` so the literal path wins over the parametric one.
 */
app.get('/active', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls, chatChannelMembers } = schema;

    const memberships = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));

    const channelIds = memberships.map((m) => m.channelId);
    if (channelIds.length === 0) return success(c, []);

    const calls = await db
      .select({
        channelId: chatCalls.channelId,
        callId: chatCalls.id,
        callType: chatCalls.callType,
        status: chatCalls.status,
        participants: chatCalls.participants,
      })
      .from(chatCalls)
      .where(
        and(
          inArray(chatCalls.channelId, channelIds),
          or(eq(chatCalls.status, 'ringing'), eq(chatCalls.status, 'active'))
        )
      );

    const result = calls.map((call) => {
      const participantCount = activeParticipantCount(call.participants);
      return {
        channelId: call.channelId,
        callId: call.callId,
        callType: call.callType,
        status: call.status,
        participantCount,
      };
    });

    return success(c, result);
  } catch (err) {
    console.error('[Chat:Calls] Failed to list active calls:', err);
    return error.internal(c, 'Failed to list active calls');
  }
});

/**
 * GET /active/:channelId - Get active call for a channel
 *
 * Also performs stale-call detection: if a call has been ringing for >60s
 * with no participants, or active for >5 min with no active participants,
 * it is automatically ended.
 */
app.get('/active/:channelId', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const channelId = c.req.param('channelId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls } = schema;

    if (!(await canAccessChannel(db, channelId, c.get('userId')))) {
      return error.forbidden(c, 'You do not have access to this channel');
    }

    const [call] = await db
      .select()
      .from(chatCalls)
      .where(
        and(
          eq(chatCalls.channelId, channelId),
          or(eq(chatCalls.status, 'ringing'), eq(chatCalls.status, 'active'))
        )
      )
      .limit(1);

    if (call) {
      const now = Date.now();
      const activeParticipants = dedupeParticipants(call.participants).filter((p) => !p.leftAt);

      const isStaleRinging =
        call.status === 'ringing' &&
        activeParticipants.length === 0 &&
        now - new Date(call.createdAt).getTime() > 60_000; // 60s with no one joining

      const isStaleActive =
        call.status === 'active' &&
        activeParticipants.length === 0 &&
        now - new Date(call.updatedAt).getTime() > 5 * 60_000; // 5 min with everyone gone

      if (isStaleRinging || isStaleActive) {
        // Auto-end orphaned call
        try {
          await endChatCall(c.get('tenantDb'), c.env, orgId, call.id, call, call.initiatorId);
        } catch (e) {
          console.error('[Chat:Calls] Failed to auto-end stale call:', e);
        }
        return success(c, null);
      }
      return success(c, { ...call, participants: dedupeParticipants(call.participants) });
    }

    return success(c, null);
  } catch (err) {
    console.error('[Chat:Calls] Failed to get active call:', err);
    return error.internal(c, 'Failed to get active call');
  }
});

/**
 * GET /:callId - Get call details
 *
 * Registered after `/active` and `/active/:channelId` so those literal paths
 * win over the parametric one.
 */
app.get('/:callId', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const callId = c.req.param('callId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls } = schema;

    const [call] = await db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1);
    if (!call) return error.notFound(c, 'Call', callId);
    if (!(await canAccessChannel(db, call.channelId, c.get('userId')))) {
      return error.forbidden(c, 'You do not have access to this call');
    }

    return success(c, { ...call, participants: dedupeParticipants(call.participants) });
  } catch (err) {
    console.error('[Chat:Calls] Failed to get call:', err);
    return error.internal(c, 'Failed to get call');
  }
});

export const chatCallsRoutes = app;
