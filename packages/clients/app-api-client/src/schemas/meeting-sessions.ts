import { z } from 'zod';

// ============================================================================
// Meeting session participant removal ("Remove from call").
//
// `participantId` is the RealtimeKit id the host sees on the peer object
// (`peer.id`); `rtkUserId` is the peer's `userId`. RealtimeKit's client does
// not document which of the two equals the REST participant id stored as
// `meeting_sessions.participants[].cfSessionId`, so the server matches either.
// `customParticipantId` is optional: when no `cfSessionId` matches, the server
// falls back to the participant's stored `userId`. Platform members join with
// customParticipantId === Clerk userId, so a member peer still resolves. Guest
// peers carry a colour seed there instead, so for guests `participantId` is
// the only reliable key.
// Permission: sessions:read on the route, then organizer-or-sessions:update.
// ============================================================================

export const removeMeetingSessionParticipantSchema = z.object({
  participantId: z.string().min(1).max(200),
  rtkUserId: z.string().min(1).max(200).optional(),
  customParticipantId: z.string().min(1).max(200).optional(),
});

export type RemoveMeetingSessionParticipantInput = z.infer<
  typeof removeMeetingSessionParticipantSchema
>;

export interface RemoveMeetingSessionParticipantResult {
  ok: true;
  /** True when RealtimeKit confirmed the kick; false when it failed (the removal itself is still recorded). */
  kicked: boolean;
  /** True when the participant was a guest and is now blocked from rejoining this session. */
  blocked: boolean;
}
