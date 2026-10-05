/**
 * Meeting Lifecycle — End Session
 *
 * The end-session logic moved to `@weldsuite/meet-domain/meeting-lifecycle` so
 * the meeting portal (guest leave) ends sessions through the very same code.
 * This module keeps the import path the route handlers and the RealtimeKit
 * webhook receiver already use, plus the session-started publisher.
 *
 * The WeldChat endChatCall path lives in @weldsuite/chat-domain/call-lifecycle.
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env } from '../../types';

export {
  endMeetingSession,
  endMeetingSessionIfEmpty,
  isMeetingPast,
} from '@weldsuite/meet-domain/meeting-lifecycle';

function getPublisher(env: Env): RealtimePublisher {
  return new RealtimePublisher(env.REALTIME!);
}

export async function publishSessionStarted(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; sessionId: string; startedBy: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityCreated(workspaceId, 'meeting_session', data, data.startedBy);
}

export async function publishMeetingUpdated(
  env: Env,
  workspaceId: string,
  data: { meetingId: string; title?: string; status?: string },
): Promise<void> {
  const rt = getPublisher(env);
  await rt.entityUpdated(workspaceId, 'meeting', data, 'system');
}
