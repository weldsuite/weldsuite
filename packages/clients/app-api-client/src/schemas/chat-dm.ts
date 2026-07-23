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
