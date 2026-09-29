/**
 * WeldMeet Realtime Publisher (app-api)
 *
 * Publishes real-time events for meeting state changes via @weldsuite/realtime.
 * Uses WorkspaceHub topics for cross-device sync.
 *
 * Ported from apps/api-worker/src/services/realtime/weldmeet-publisher.ts.
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env } from '../../types';

function getPublisher(env: Env): RealtimePublisher {
  return new RealtimePublisher(env.REALTIME!);
}

// ============================================================================
// Workspace-level events (WorkspaceHub — for list/dashboard sync)
// ============================================================================

export async function publishMeetingCreated(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; title: string; organizerId: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityCreated(workspaceId, 'meeting', data, data.organizerId);
}

export async function publishMeetingUpdated(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; title?: string; status?: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityUpdated(workspaceId, 'meeting', data, 'system');
}

export async function publishMeetingDeleted(
  env: Env,
  workspaceId: string,
  meetingId: string,
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityDeleted(workspaceId, 'meeting', meetingId, 'system');
}

export async function publishSessionStarted(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; sessionId: string; startedBy: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityCreated(workspaceId, 'meeting_session', data, data.startedBy);
}

export async function publishSessionEnded(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; sessionId: string; duration?: number },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityUpdated(workspaceId, 'meeting_session', { ...data, status: 'ended' }, 'system');
}

// ============================================================================
// User-level events (WorkspaceHub — for notifications/invites)
// ============================================================================

export async function publishMeetingInvite(
  env: Env,
  workspaceId: string,
  userId: string,
  data: {
    meetingId: string;
    title: string;
    organizerName: string;
    scheduledStart?: string;
  },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.publish(workspaceId, `meeting.user.${userId}`, 'meeting:invite', data, 'system');
}

export async function publishMeetingStartingSoon(
  env: Env,
  workspaceId: string,
  userId: string,
  data: { meetingId: string; title: string; startsAt: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.publish(workspaceId, `meeting.user.${userId}`, 'meeting:starting_soon', data, 'system');
}
