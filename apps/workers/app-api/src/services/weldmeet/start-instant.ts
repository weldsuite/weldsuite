/**
 * WeldMeet — Start Instant Meeting Service (app-api)
 *
 * Collapses the legacy "create meeting → start session → join session"
 * sequence into a single backend operation. Used by the platform's
 * "Start an instant meeting" button.
 *
 * Stability guardrails:
 * - Same DB tables / columns as the legacy flow (no schema changes).
 * - Same activeSessionId invariant: meeting.activeSessionId points at the
 *   inserted session row.
 * - Webhook resolution preserved: writes the same `rtk-meeting:<rtkId>` KV
 *   mapping the legacy `/sessions/start` route does.
 * - First participant is added with the HOST preset.
 *
 * Ported from apps/core-api/src/services/weldmeet/start-instant.ts.
 */

import {
  createMeeting as createRtkMeeting,
  addParticipant,
  ensurePresets,
  RTK_PRESETS,
  type CloudflareRealtimeEnv,
  type RealtimeExecutionCtx,
  type RealtimeKvNamespace,
} from '@weldsuite/cloudflare-realtime';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { resolveParticipantLink } from '../../lib/participant-resolver';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';

function generateJoinCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const segment = () =>
    Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `wm-${segment()}-${segment()}-${segment()}`;
}

export interface StartInstantMeetingParams {
  userId: string;
  orgId: string;
  user: { name: string; email?: string; picture?: string };
  input: {
    title?: string;
    meetingType?: 'video' | 'audio';
    accessType?: 'workspace' | 'invited_only' | 'anyone_with_link';
    waitingRoom?: boolean;
  };
}

export interface StartInstantMeetingResult {
  meetingId: string;
  sessionId: string;
  rtkMeetingId: string;
  authToken: string;
  joinCode: string;
  participants: MeetingSessionParticipant[];
  timings: Record<string, number>;
}

export async function startInstantMeeting(
  db: Database,
  env: CloudflareRealtimeEnv & {
    WORKSPACE_CACHE: RealtimeKvNamespace;
    STORAGE?: R2Bucket;
    R2_PUBLIC_URL?: string;
  },
  ctx: RealtimeExecutionCtx,
  params: StartInstantMeetingParams,
): Promise<StartInstantMeetingResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  const { meetings, meetingSessions } = schema;
  const { userId, orgId, user, input } = params;

  const meetingId = generateId('meet');
  const sessionId = generateId('msess');
  const joinCode = generateJoinCode();
  const now = new Date();

  const title = input.title ?? 'Instant Meeting';
  const meetingType = input.meetingType ?? 'video';
  const accessType = input.accessType ?? 'anyone_with_link';
  const waitingRoom = input.waitingRoom ?? true;

  // ensurePresets returns immediately on a KV hit (steady-state path).
  // On a miss it awaits the seed: ~5 serial api.cloudflare.com calls.
  await ensurePresets(env, ctx);
  timings.presets = Date.now() - t0;

  // createRtkMeeting (Cloudflare REST roundtrip) and resolveParticipantLink
  // (tenant-DB lookup) are independent — run concurrently.
  const [rtkMeeting, organizerLink] = await Promise.all([
    createRtkMeeting(env, title),
    resolveParticipantLink(db, env, orgId, {
      userId,
      email: user.email,
      name: user.name,
    }),
  ]);
  timings.rtkCreate = Date.now() - t0;

  const avatar = organizerLink.avatarUrl ?? user.picture;

  const rtkParticipant = await addParticipant(env, rtkMeeting.id, {
    name: user.name,
    customParticipantId: userId,
    presetName: RTK_PRESETS.HOST,
    picture: avatar,
  });
  timings.rtkJoin = Date.now() - t0;

  const firstParticipant: MeetingSessionParticipant = {
    userId,
    userName: user.name,
    userAvatar: avatar,
    joinedAt: now.toISOString(),
    cfSessionId: rtkParticipant.id,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...(organizerLink.workspaceMemberId ? { workspaceMemberId: organizerLink.workspaceMemberId } : {}),
    ...(organizerLink.personId ? { personId: organizerLink.personId } : {}),
  };

  // Insert the meeting row with the organizer baked into attendees, status
  // already 'in_progress' (this meeting starts immediately).
  await db.insert(meetings).values({
    id: meetingId,
    title,
    organizerId: userId,
    attendees: [
      {
        userId,
        email: user.email ?? '',
        name: user.name,
        status: 'accepted',
        role: 'organizer',
        ...(organizerLink.workspaceMemberId ? { workspaceMemberId: organizerLink.workspaceMemberId } : {}),
        ...(organizerLink.personId ? { personId: organizerLink.personId } : {}),
      },
    ],
    meetingType,
    status: 'in_progress',
    accessType,
    waitingRoom,
    allowRecording: true,
    joinCode,
    activeSessionId: sessionId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(meetingSessions).values({
    id: sessionId,
    meetingId,
    sessionType: meetingType,
    status: 'active',
    cfAppId: rtkMeeting.id,
    startedBy: userId,
    startedByName: user.name,
    participants: [firstParticipant],
    maxParticipants: 1,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  timings.dbWrite = Date.now() - t0;

  // KV mapping for inbound webhook resolution — fire and forget.
  ctx.waitUntil(
    (env.WORKSPACE_CACHE as KVNamespace).put(
      `rtk-meeting:${rtkMeeting.id}`,
      JSON.stringify({ orgId, type: 'session', sessionId, meetingId }),
      { expirationTtl: 86400 },
    ).catch((e) => console.warn('[StartInstant] KV write failed (non-fatal):', e)),
  );

  timings.total = Date.now() - t0;

  return {
    meetingId,
    sessionId,
    rtkMeetingId: rtkMeeting.id,
    authToken: rtkParticipant.token,
    joinCode,
    participants: [firstParticipant],
    timings,
  };
}
