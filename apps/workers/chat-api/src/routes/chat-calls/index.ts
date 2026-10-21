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
import { createMeeting, addParticipant } from '@weldsuite/cloudflare-realtime';
import { sendMissedCallNotification, sendIncomingCallNotification } from '@weldsuite/notifications';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Env, Variables } from '../../types';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { success, error } from '@weldsuite/worker-kit/response';
import {
  publishChatCallStarted,
  publishChatCallEnded,
  publishChatCallParticipantJoined,
  publishChatCallParticipantLeft,
  publishChatCallIncoming,
  broadcastChatCallToMembers,
} from '@weldsuite/chat-domain/realtime/weldchat-call-publisher';
import {
  endChatCall,
  endChatCallIfEmpty,
  scheduleRingTimeout,
  teardownRtkMeeting,
  wasAnswered,
  type EndIfEmptyOutcome,
} from '@weldsuite/chat-domain/call-lifecycle';
import { getDmCallRoom, rememberDmCallRoom } from '@weldsuite/chat-domain/dm-call-room';
import { canAccessChannel } from '../../services/chat/channel-access';
import {
  dedupeParticipants,
  activeParticipantCount,
  upsertParticipant,
  evictRtkSessions,
  isAbandonedCall,
} from '../../services/chat/call-participants';
import { leaveOtherLiveCalls } from '../../services/chat/leave-other-live-calls';
import { consumePreparedJoin, readPreparedJoin, storePreparedJoin } from '../../services/chat/prepared-join';

// ============================================================================
// Schemas
// ============================================================================

const startCallSchema = z.object({
  channelId: z.string().min(1),
  callType: z.enum(['voice', 'video']).default('voice'),
});

type CallType = z.infer<typeof startCallSchema>['callType'];
type ChatCallRow = typeof schema.chatCalls.$inferSelect;

// ============================================================================
// Helpers
// ============================================================================

/** Message for a call type the channel has switched off, or null when allowed. */
function disabledCallMessage(
  callType: CallType,
  channel: { voiceCallsEnabled: boolean; videoCallsEnabled: boolean } | undefined,
): string | null {
  if (!channel) return null;
  if (callType === 'voice' && !channel.voiceCallsEnabled) return 'Voice calls are disabled in this channel';
  if (callType === 'video' && !channel.videoCallsEnabled) return 'Video calls are disabled in this channel';
  return null;
}

/**
 * Ends a call that looks abandoned so a new one can start, unless RealtimeKit
 * still has people in its room: our participant list alone never ends a call
 * (see endChatCallIfEmpty). In a DM one remaining connection does not count,
 * that is the requester's own leftover or someone waiting alone, and the new
 * call rings them. Only `ended` lets the new call start. On `occupied` the
 * call is live after all, so the caller joins it (or gets a conflict). On
 * `unknown` nothing may be assumed: joining a call that may be dead would
 * leave the caller alone in it without ringing anyone.
 * No missed-call push: the new call is about to ring the same people.
 */
async function endStaleCall(
  db: Database,
  env: Env,
  orgId: string,
  call: ChatCallRow,
  isDm: boolean,
): Promise<EndIfEmptyOutcome> {
  try {
    return await endChatCallIfEmpty(db, env, orgId, call.id, call, call.initiatorId, {
      sendMissedIfUnanswered: false,
      endWhenAlone: isDm,
    });
  } catch {
    // The end itself failed half-way. Best effort, as before: let the new call start.
    return 'ended';
  }
}

interface IncomingCallParams {
  db: Database;
  env: Env;
  orgId: string;
  userId: string;
  channelId: string;
  callType: CallType;
  callId: string;
  initiatorName: string;
  initiatorPicture: string | undefined;
}

/**
 * Realtime ring plus (non-blocking) push for one DM member. Never throws, so one
 * failed ring neither cuts the other members' rings short nor skips the ring
 * timeout that ends an unanswered call.
 */
async function ringDmMember(p: IncomingCallParams, memberUserId: string): Promise<void> {
  try {
    await publishChatCallIncoming(p.env, p.orgId, memberUserId, {
      callId: p.callId,
      channelId: p.channelId,
      callType: p.callType,
      callerName: p.initiatorName,
      callerAvatar: p.initiatorPicture,
    });
  } catch (e) {
    console.error('[Chat:Calls] Incoming-call ring failed:', e);
  }
  // Push notification (non-blocking) — never block the response.
  try {
    await sendIncomingCallNotification({
      db: p.db,
      env: p.env,
      workspaceId: p.orgId,
      recipientUserId: memberUserId,
      callerUserId: p.userId,
      callerName: p.initiatorName,
      callerAvatar: p.initiatorPicture,
      channelId: p.channelId,
      callId: p.callId,
      callType: p.callType,
    });
  } catch (e) {
    console.error('[Chat:Calls] Incoming-call notification failed:', e);
  }
}

/**
 * Publishes the call-started events and, for DM channels (incl. group DMs),
 * rings every other member. Never throws: realtime is best effort.
 */
async function publishCallStarted(
  p: IncomingCallParams,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
  try {
    await publishChatCallStarted(p.env, p.channelId, {
      callId: p.callId,
      callType: p.callType,
      initiatorId: p.userId,
      initiatorName: p.initiatorName,
    });
    await broadcastChatCallToMembers(p.env, p.db, p.orgId, p.channelId, 'started', {
      callId: p.callId,
      callType: p.callType,
    });

    const { chatChannels, chatChannelMembers } = schema;
    const [channel] = await p.db
      .select({ type: chatChannels.type })
      .from(chatChannels)
      .where(eq(chatChannels.id, p.channelId))
      .limit(1);

    if (channel?.type !== 'dm') return;

    const members = await p.db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, p.channelId));

    await Promise.all(
      members.filter((m) => m.userId !== p.userId).map((member) => ringDmMember(p, member.userId)),
    );
    scheduleRingTimeout(waitUntil, p.db, p.env, p.orgId, p.callId);
  } catch (e) {
    console.error('[Chat:Calls] Realtime publish failed:', e);
  }
}

interface JoinExistingCallParams {
  db: Database;
  env: Env;
  orgId: string;
  userId: string;
  channelId: string;
  call: ChatCallRow;
  cfAppId: string;
  joiner: { name: string | null; picture: string | null } | undefined;
  waitUntil: (promise: Promise<unknown>) => void;
  /** When the joining request started (see leaveOtherLiveCalls). */
  requestStartedAt: number;
}

/**
 * Joins the call already live in a channel (start-and-join on an active call).
 * The requested callType is ignored: you join the call that exists.
 */
async function joinExistingCall(p: JoinExistingCallParams) {
  const { db, env, call, cfAppId, userId } = p;
  const joinName = p.joiner?.name ?? 'Unknown';
  const joinAvatar = p.joiner?.picture ?? undefined;
  const rtkParticipant = await addParticipant(env, cfAppId, {
    name: joinName,
    customParticipantId: userId,
    picture: joinAvatar,
  });
  const joinParticipant: ChatCallParticipant = {
    userId,
    userName: joinName,
    userAvatar: joinAvatar,
    joinedAt: new Date().toISOString(),
    cfSessionId: rtkParticipant.id,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
  };
  // Idempotent on userId; surfaces stale sessions to evict.
  const { next: merged, staleSessionIds } = upsertParticipant(call.participants, joinParticipant);
  p.waitUntil(
    Promise.all([
      db.update(schema.chatCalls).set({
        participants: merged,
        maxParticipants: Math.max(call.maxParticipants ?? 0, merged.filter((m) => !m.leftAt).length),
        updatedAt: new Date(),
      }).where(eq(schema.chatCalls.id, call.id)),
      evictRtkSessions(env, cfAppId, staleSessionIds, { orgId: p.orgId, userId, callId: call.id }),
      leaveOtherLiveCalls(db, env, p.orgId, userId, call.id, p.requestStartedAt),
      publishChatCallParticipantJoined(env, p.channelId, {
        callId: call.id,
        userId,
        userName: joinName,
        userAvatar: joinAvatar,
        cfSessionId: rtkParticipant.id,
      }).catch(() => {}),
    ]).catch((e) => console.error('[Chat:Calls] Background join-existing tasks failed:', e)),
  );
  return {
    callId: call.id,
    authToken: rtkParticipant.token,
    participants: merged,
    callType: call.callType,
  };
}

interface StartNewCallParams {
  db: Database;
  env: Env;
  orgId: string;
  userId: string;
  channelId: string;
  callType: CallType;
  isDm: boolean;
  /** The DM's stored room, from `getDmCallRoom`. */
  dmRoomId: string | null;
  author: { name: string | null; picture: string | null } | undefined;
  waitUntil: (promise: Promise<unknown>) => void;
  /** When the starting request began (see leaveOtherLiveCalls). */
  requestStartedAt: number;
}

/** The state of a call being started, shared by the steps of {@link startNewCall}. */
interface NewCall extends StartNewCallParams {
  callId: string;
  msgId: string;
  now: Date;
  initiatorName: string;
  initiatorPicture: string | undefined;
  callLabel: string;
  participant: ChatCallParticipant;
  /** Resolves once the call row, its system message and the KV mapping are written. */
  persisted: Promise<unknown>;
}

function mapMeetingToCall(call: NewCall, meetingId: string): Promise<void> {
  return call.env.WORKSPACE_CACHE.put(
    `rtk-meeting:${meetingId}`,
    JSON.stringify({ orgId: call.orgId, type: 'call', callId: call.callId, channelId: call.channelId }),
    { expirationTtl: 86400 },
  );
}

/**
 * Ring the other DM members as soon as the call row exists (the callee's
 * prepare / join reads it), without waiting for the caller's own token: the
 * other side starts ringing while the caller is still being added to the room.
 */
function ringDmMembersOnceSaved(call: NewCall): void {
  const ringParams: IncomingCallParams = {
    db: call.db,
    env: call.env,
    orgId: call.orgId,
    userId: call.userId,
    channelId: call.channelId,
    callType: call.callType,
    callId: call.callId,
    initiatorName: call.initiatorName,
    initiatorPicture: call.initiatorPicture,
  };
  call.waitUntil(
    call.persisted
      .then(async () => {
        const members = await call.db
          .select({ userId: schema.chatChannelMembers.userId })
          .from(schema.chatChannelMembers)
          .where(eq(schema.chatChannelMembers.channelId, call.channelId));
        await Promise.all(
          members.filter((m) => m.userId !== call.userId).map((m) => ringDmMember(ringParams, m.userId)),
        );
        scheduleRingTimeout(call.waitUntil, call.db, call.env, call.orgId, call.callId);
      })
      .catch((e) => console.error('[Chat:Calls] Incoming-call ring failed:', e)),
  );
}

/**
 * Add the caller to the call's room. When the DM's stored room turns out to be
 * gone (deleted, deactivated elsewhere), give the DM a new one and move the
 * call into it.
 */
async function addCallerToRoom(call: NewCall, meetingId: string, reusedRoom: boolean): Promise<{ id: string; token: string }> {
  const callerParams = { name: call.initiatorName, customParticipantId: call.userId, picture: call.initiatorPicture };
  try {
    return await addParticipant(call.env, meetingId, callerParams);
  } catch (err) {
    if (!reusedRoom) throw err;
    console.warn('[Chat:Calls] Persistent DM room unusable, replacing it:', err);
    const fresh = await createMeeting(call.env, `${call.initiatorName}'s ${call.callLabel}`);
    await call.persisted;
    await Promise.all([
      call.db.update(schema.chatCalls).set({ cfAppId: fresh.id }).where(eq(schema.chatCalls.id, call.callId)),
      mapMeetingToCall(call, fresh.id),
      rememberDmCallRoom(call.env.WORKSPACE_CACHE, call.orgId, call.channelId, fresh.id),
    ]);
    return addParticipant(call.env, fresh.id, callerParams);
  }
}

/** The ring may already be out: end the call rather than leave it ringing for a caller who never got in. */
function endFailedStart(call: NewCall): void {
  call.waitUntil(
    call.persisted
      .then(() =>
        endChatCall(call.db, call.env, call.orgId, call.callId, {
          startedAt: call.now,
          cfAppId: null,
          channelId: call.channelId,
          initiatorId: call.userId,
          initiatorName: call.initiatorName,
          status: 'active',
          callType: call.callType,
          participants: [call.participant],
        }, call.userId, { sendMissedIfUnanswered: false }),
      )
      .catch((e) => console.error('[Chat:Calls] Ending the failed call failed:', e)),
  );
}

/** Record the caller's session, link the system message, enforce one call at a time, publish. Non-blocking. */
function finishStartInBackground(call: NewCall, cfSessionId: string): void {
  const { db, env, orgId, userId, callId, channelId, participant } = call;
  participant.cfSessionId = cfSessionId;
  call.waitUntil(
    Promise.all([
      // Re-read before writing so a racing /join isn't clobbered, then upsert
      // self (idempotent on userId). Also enforce one-call-at-a-time.
      (async () => {
        const [fresh] = await db.select().from(schema.chatCalls).where(eq(schema.chatCalls.id, callId)).limit(1);
        const { next } = upsertParticipant(fresh?.participants, participant);
        await db.update(schema.chatCalls).set({
          participants: next,
          maxParticipants: Math.max(fresh?.maxParticipants ?? 0, next.filter((p) => !p.leftAt).length),
          startMessageId: call.msgId,
        }).where(eq(schema.chatCalls.id, callId));
        await leaveOtherLiveCalls(db, env, orgId, userId, callId, call.requestStartedAt);
      })(),
      // Publish realtime events
      publishChatCallStarted(env, channelId, {
        callId,
        callType: call.callType,
        initiatorId: userId,
        initiatorName: call.initiatorName,
      }).catch(() => {}),
      broadcastChatCallToMembers(env, db, orgId, channelId, 'started', {
        callId,
        callType: call.callType,
      }).catch(() => {}),
      publishChatCallParticipantJoined(env, channelId, {
        callId,
        userId,
        userName: call.initiatorName,
        userAvatar: call.initiatorPicture,
        cfSessionId,
      }).catch(() => {}),
    ]).catch((e) => console.error('[Chat:Calls] Background tasks failed:', e)),
  );
}

/**
 * Start a new call (start-and-join when no call is live in the channel). A DM
 * reuses its persistent room, so the usual call skips createMeeting (a
 * Cloudflare API round-trip) entirely; other channels get a fresh room. The
 * call record, ring and the caller's addParticipant run in parallel.
 */
async function startNewCall(p: StartNewCallParams) {
  const initiatorName = p.author?.name ?? 'Unknown';
  const initiatorPicture = p.author?.picture ?? undefined;
  const callLabel = p.callType === 'video' ? 'video call' : 'voice call';
  const now = new Date();

  const reusedRoom = p.isDm && !!p.dmRoomId;
  const meetingId = p.isDm && p.dmRoomId
    ? p.dmRoomId
    : (await createMeeting(p.env, `${initiatorName}'s ${callLabel}`)).id;
  if (p.isDm) {
    // Store a new room, or refresh the TTL of the one just used.
    p.waitUntil(rememberDmCallRoom(p.env.WORKSPACE_CACHE, p.orgId, p.channelId, meetingId));
  }

  const call: NewCall = {
    ...p,
    callId: generateId('call'),
    msgId: generateId('msg'),
    now,
    initiatorName,
    initiatorPicture,
    callLabel,
    participant: {
      userId: p.userId,
      userName: initiatorName,
      userAvatar: initiatorPicture,
      joinedAt: now.toISOString(),
      cfSessionId: '', // filled after addParticipant
      hasAudio: false,
      hasVideo: false,
      hasScreenShare: false,
    },
    persisted: Promise.resolve(),
  };

  // Call record + system message + KV mapping, in parallel with the caller's addParticipant.
  call.persisted = Promise.all([
    p.db.insert(schema.chatCalls).values({
      id: call.callId,
      channelId: p.channelId,
      callType: p.callType,
      status: 'active',
      cfAppId: meetingId,
      initiatorId: p.userId,
      initiatorName,
      participants: [call.participant],
      maxParticipants: 1,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    p.db.insert(schema.chatMessages).values({
      id: call.msgId,
      channelId: p.channelId,
      authorId: p.userId,
      authorName: initiatorName,
      authorAvatar: initiatorPicture ?? null,
      content: `${initiatorName} started a ${callLabel}`,
      type: 'system',
      createdAt: now,
      updatedAt: now,
    }),
    mapMeetingToCall(call, meetingId),
  ]);

  if (p.isDm) ringDmMembersOnceSaved(call);

  let rtkParticipant: { id: string; token: string };
  try {
    [rtkParticipant] = await Promise.all([addCallerToRoom(call, meetingId, reusedRoom), call.persisted]);
  } catch (err) {
    endFailedStart(call);
    throw err;
  }

  finishStartInBackground(call, rtkParticipant.id);
  return {
    callId: call.callId,
    authToken: rtkParticipant.token,
    participants: [call.participant],
    callType: p.callType,
  };
}

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
        type: chatChannels.type,
      })
      .from(chatChannels)
      .where(eq(chatChannels.id, data.channelId))
      .limit(1);

    const disabledMessage = disabledCallMessage(data.callType, channel);
    if (disabledMessage) return error.forbidden(c, disabledMessage);

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

      // A live call blocks the new one; a stale one is ended so it can start.
      const isDm = channel?.type === 'dm';
      if (
        !fullCall ||
        !isAbandonedCall(fullCall, { isDm, requesterId: userId }) ||
        (await endStaleCall(db, c.env, orgId, fullCall, isDm)) !== 'ended'
      ) {
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
    await publishCallStarted(
      {
        db,
        env: c.env,
        orgId,
        userId,
        channelId: data.channelId,
        callType: data.callType,
        callId,
        initiatorName,
        initiatorPicture: author?.picture ?? undefined,
      },
      c.executionCtx.waitUntil.bind(c.executionCtx),
    );

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
  const requestStartedAt = Date.now();

  try {
    const db = c.get('tenantDb');
    const { chatCalls, chatChannels, chatChannelMembers, workspaceMembers } = schema;

    // Run membership check + channel permissions + active call check + user info
    // + the DM's persistent room in parallel
    const [membershipResult, channelResult, activeCallResult, authorResult, dmRoomId] = await Promise.all([
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
      // Read for every channel (it is one KV get); only a DM uses it.
      getDmCallRoom(c.env.WORKSPACE_CACHE, orgId, data.channelId),
    ]);

    if (!membershipResult[0]) {
      return error.forbidden(c, 'You are not a member of this channel');
    }

    const channel = channelResult[0];
    const disabledMessage = disabledCallMessage(data.callType, channel);
    if (disabledMessage) return error.forbidden(c, disabledMessage);

    const isDm = channel?.type === 'dm';
    const existingCall = activeCallResult[0];
    if (existingCall) {
      // A call that looks abandoned is ended so the new one can start (and
      // ring), unless RealtimeKit still has people in it: then it is live
      // after all and the caller joins it like any other ongoing call. If
      // RealtimeKit cannot be asked the call is neither replaced nor joined:
      // joining one that is in fact dead would ring nobody.
      const outcome = isAbandonedCall(existingCall, { isDm, requesterId: userId })
        ? await endStaleCall(db, c.env, orgId, existingCall, isDm)
        : 'occupied';

      if (outcome !== 'ended') {
        if (outcome === 'unknown' || !existingCall.cfAppId) {
          return error.conflict(c, 'A call is already active in this channel');
        }
        // A call is already active in this channel — JOIN it instead of
        // erroring, so the caller "just joins" the ongoing call.
        const joined = await joinExistingCall({
          db,
          env: c.env,
          orgId,
          userId,
          channelId: data.channelId,
          call: existingCall,
          cfAppId: existingCall.cfAppId,
          joiner: authorResult[0],
          waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
          requestStartedAt,
        });
        return success(c, joined, 200);
      }
    }

    const started = await startNewCall({
      db,
      env: c.env,
      orgId,
      userId,
      channelId: data.channelId,
      callType: data.callType,
      isDm,
      dmRoomId,
      author: authorResult[0],
      waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
      requestStartedAt,
    });
    return success(c, started, 201);
  } catch (err) {
    console.error('[Chat:Calls] Failed to start-and-join call:', err);
    return error.internal(c, 'Failed to start call');
  }
});

/**
 * POST /:callId/prepare - Get a RealtimeKit token for a call that is ringing
 * for you, before you answer it.
 *
 * The callee's client calls this when the ring arrives, so accepting no longer
 * waits for Cloudflare to add a participant: it connects with this token at
 * once while POST /:callId/join records the answer (and reuses this same
 * participant, see services/chat/prepared-join.ts). Records nothing on the
 * call itself: preparing is not answering, and a declined or missed call
 * leaves only an unused participant behind.
 */
app.post('/:callId/prepare', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const callId = c.req.param('callId');

  try {
    const db = c.get('tenantDb');
    const { chatCalls, workspaceMembers } = schema;

    const [callResult, authorResult, prepared] = await Promise.all([
      db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1),
      db.select({ name: workspaceMembers.name, picture: workspaceMembers.picture }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).limit(1),
      readPreparedJoin(c.env.WORKSPACE_CACHE, callId, userId),
    ]);

    const [call] = callResult;
    if (!call) return error.notFound(c, 'Call', callId);
    // Same boundary as /join: a token is as good as joining.
    if (!(await canAccessChannel(db, call.channelId, userId))) {
      return error.forbidden(c, 'You do not have access to this call');
    }
    if (call.status !== 'ringing' && call.status !== 'active') {
      return error.badRequest(c, 'Call is not joinable');
    }
    if (!call.cfAppId) {
      return error.internal(c, 'Call has no meeting ID');
    }

    // A second ring delivery or another tab gets the participant already parked.
    let ready = prepared?.meetingId === call.cfAppId ? prepared : null;
    if (!ready) {
      const author = authorResult[0];
      const rtkParticipant = await addParticipant(c.env, call.cfAppId, {
        name: author?.name ?? 'Unknown',
        customParticipantId: userId,
        picture: author?.picture ?? undefined,
      });
      ready = { meetingId: call.cfAppId, participantId: rtkParticipant.id, token: rtkParticipant.token };
      await storePreparedJoin(c.env.WORKSPACE_CACHE, callId, userId, ready);
    }

    return success(c, {
      callId,
      channelId: call.channelId,
      callType: call.callType,
      authToken: ready.token,
    });
  } catch (err) {
    console.error('[Chat:Calls] Failed to prepare call join:', err);
    return error.internal(c, 'Failed to prepare call');
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
  const requestStartedAt = Date.now();

  try {
    const db = c.get('tenantDb');
    const { chatCalls, workspaceMembers } = schema;

    // Fetch call + user info + a participant prepared while it rang, in parallel
    const [callResult, authorResult, prepared] = await Promise.all([
      db.select().from(chatCalls).where(eq(chatCalls.id, callId)).limit(1),
      db.select({ name: workspaceMembers.name, picture: workspaceMembers.picture }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).limit(1),
      readPreparedJoin(c.env.WORKSPACE_CACHE, callId, userId),
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

    // The participant POST /prepare added while it rang (the client is already
    // connecting with its token), else add one now → auth token.
    const reusable = prepared?.meetingId === call.cfAppId ? prepared : null;
    const rtkParticipant = reusable
      ? { id: reusable.participantId, token: reusable.token }
      : await addParticipant(c.env, call.cfAppId, {
          name: userName,
          customParticipantId: userId,
          picture: author?.picture ?? undefined,
        });
    if (prepared) {
      c.executionCtx.waitUntil(consumePreparedJoin(c.env.WORKSPACE_CACHE, callId, userId));
    }

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
        evictRtkSessions(c.env, call.cfAppId, staleSessionIds, { orgId, userId, callId }),
        leaveOtherLiveCalls(db, c.env, orgId, userId, callId, requestStartedAt),
        publishChatCallParticipantJoined(c.env, call.channelId, {
          callId,
          userId,
          userName,
          userAvatar: author?.picture ?? undefined,
          cfSessionId: rtkParticipant.id,
        }).catch((e) => console.error('[Chat:Calls] Realtime publish failed:', e)),
      ]).catch((e) => console.error('[Chat:Calls] Background join tasks failed:', e)),
    );

    // The channel and type let a client connect straight from this answer,
    // without fetching the call first.
    return success(c, {
      callId,
      channelId: call.channelId,
      callType: call.callType,
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
 * When our list shows nobody left, the call is ended only if RealtimeKit
 * confirms the room is empty: the list can be wrong, and ending kicks whoever
 * is still inside. If someone is, the call stays and RealtimeKit's own
 * meeting.ended webhook ends it once the room empties.
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
    // e.g. the one-call-at-a-time eviction tore it down first). A call nobody
    // answered can only hold the leaver's own connection (a client that
    // reports the leave before RealtimeKit has let go of it), so that one
    // must not keep the callee ringing.
    if (activeParticipants.length === 0 && (call.status === 'active' || call.status === 'ringing')) {
      await endChatCallIfEmpty(c.get('tenantDb'), c.env, orgId, callId, call, userId, {
        endWhenAlone: !wasAnswered(call),
      });
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
    // start-and-join (what both clients use) creates the call as 'active' with
    // the caller already in it, so an unanswered 'active' call is still ringing.
    const isRinging = call.status === 'ringing' || (call.status === 'active' && !wasAnswered(call));
    if (!isRinging) return error.badRequest(c, 'Call is not ringing');

    const now = new Date();
    await db.update(chatCalls).set({
      status: 'declined',
      endedAt: now,
      updatedAt: now,
    }).where(eq(chatCalls.id, callId));

    // Kick the caller out of the room, end the RTK meeting, drop the KV mapping
    if (call.cfAppId) {
      await teardownRtkMeeting(c.env, call.cfAppId, { callId, orgId, channelId: call.channelId, endedAt: now });
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
    const { chatCalls, chatChannelMembers, chatChannels } = schema;

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
        initiatorId: chatCalls.initiatorId,
        initiatorName: chatCalls.initiatorName,
        channelType: chatChannels.type,
      })
      .from(chatCalls)
      .innerJoin(chatChannels, eq(chatChannels.id, chatCalls.channelId))
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
        initiatorId: call.initiatorId,
        initiatorName: call.initiatorName,
        channelType: call.channelType,
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
 * it is automatically ended, but only once RealtimeKit confirms the room is
 * empty. If people are still in it the call is returned as usual.
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
        let outcome: Awaited<ReturnType<typeof endChatCallIfEmpty>> = 'unknown';
        try {
          outcome = await endChatCallIfEmpty(c.get('tenantDb'), c.env, orgId, call.id, call, call.initiatorId);
        } catch (e) {
          console.error('[Chat:Calls] Failed to auto-end stale call:', e);
        }
        if (outcome === 'ended') return success(c, null);
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
