/**
 * Meeting API Client
 *
 * Client-side fetch wrapper for the meeting portal's own API routes.
 * No auth headers — guests are unauthenticated. Responses are validated with
 * Zod so React state never sees a corrupt payload.
 */

import {
  guestJoinResultSchema,
  meetingInfoSchema,
  waitlistStatusResponseSchema,
  type GuestJoinResult,
  type MeetingInfo,
  type WaitlistStatus,
} from './schemas';

interface ApiError {
  error?: { message?: string };
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ApiError;
  return body?.error?.message || `${fallback} (${res.status})`;
}

export async function getGuestMeetingInfo(
  orgId: string,
  joinCode: string,
): Promise<MeetingInfo> {
  const res = await fetch(
    `/api/meeting/info?orgId=${encodeURIComponent(orgId)}&joinCode=${encodeURIComponent(joinCode)}`,
  );
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to get meeting info'));
  }
  const json = (await res.json()) as { data: unknown };
  return meetingInfoSchema.parse(json.data);
}

export async function guestJoinMeeting(
  orgId: string,
  body: { joinCode: string; name: string; email: string; colorSeed?: string },
): Promise<GuestJoinResult> {
  const res = await fetch('/api/meeting/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId, ...body }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to join meeting'));
  }
  const json = (await res.json()) as { data: unknown };
  return guestJoinResultSchema.parse(json.data);
}

export async function guestLeaveMeeting(
  orgId: string,
  body: { meetingId: string; sessionId: string; email: string },
): Promise<void> {
  await fetch('/api/meeting/leave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId, ...body }),
  });
}

export async function getGuestWaitlistStatus(
  orgId: string,
  meetingId: string,
  waitlistId: string,
): Promise<WaitlistStatus> {
  const url = `/api/meeting/${encodeURIComponent(meetingId)}/waitlist-status`
    + `?orgId=${encodeURIComponent(orgId)}`
    + `&waitlistId=${encodeURIComponent(waitlistId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to fetch waitlist status'));
  }
  const json = (await res.json()) as { data: unknown };
  return waitlistStatusResponseSchema.parse(json.data).status;
}
