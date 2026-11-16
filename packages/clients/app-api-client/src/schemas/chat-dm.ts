import { z } from 'zod';

// ============================================================================
// WeldChat direct-message channels — create-or-get a DM channel for a set of
// users. A DM is a `chatChannels` row of type `dm`; participants are
// `chatChannelMembers` rows.
//
// Backed by `chat_channels` + `chat_channel_members`
// (packages/db/src/schema/chat-channels, chat-channel-members).
// Permission prefix: `messages:*`.
// ============================================================================

export const createDmSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1),
});

export type CreateDmInput = z.infer<typeof createDmSchema>;

// ----------------------------------------------------------------------------
// Invitees — someone invited to the workspace but not yet accepted can't be in
// a DM. Their member row is written before they have an account, under a
// placeholder user id that accepting the invitation swaps for the real one, so
// a DM made before then would never reach them. chat-api answers such a DM
// with a 409 whose `error.details.reason` is DM_INVITATION_PENDING; the
// platform and mobile pickers leave invitees out (or disabled) first. The Rust
// port keeps its own copy of the prefixes (rust/modules/chat/src/groups/dm.rs).
// ----------------------------------------------------------------------------

/** User-id prefixes of an invitation's member row (`invited_<email>`, `pending_clerk_<invitation>`). */
export const INVITE_PLACEHOLDER_USER_ID_PREFIXES = ['invited_', 'pending_clerk_'] as const;

/** `error.details.reason` of chat-api's 409 for a DM with someone who hasn't accepted their invitation. */
export const DM_INVITATION_PENDING = 'invitation_pending';

/** True for a user id that is still an invitation's placeholder. */
export function isInvitePlaceholderUserId(userId: string | null | undefined): boolean {
  return !!userId && INVITE_PLACEHOLDER_USER_ID_PREFIXES.some((prefix) => userId.startsWith(prefix));
}

/**
 * True for a workspace member who was invited but has not accepted yet: a
 * PENDING row, or one still on a placeholder id (the Clerk webhook can mark it
 * ACTIVE a moment before it learns the real user id).
 */
export function isPendingInvitee(member: { status?: string | null; userId?: string | null }): boolean {
  return member.status?.toUpperCase() === 'PENDING' || isInvitePlaceholderUserId(member.userId);
}

// ----------------------------------------------------------------------------
// DM membership mutations — archive / unarchive / pin / delete a DM for the
// current user, and mute a channel for the current user.
// ----------------------------------------------------------------------------

/** PATCH /chat-dm/:channelId/pin — pin/unpin the DM for the current user. */
export const pinDmSchema = z.object({
  isPinned: z.boolean(),
});

export type PinDmInput = z.infer<typeof pinDmSchema>;

/** PATCH /channels/:channelId/me — mute/unmute the channel for the current user. */
export const updateChannelMembershipSchema = z.object({
  isMuted: z.boolean(),
});

export type UpdateChannelMembershipInput = z.infer<typeof updateChannelMembershipSchema>;
