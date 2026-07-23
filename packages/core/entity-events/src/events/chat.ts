/**
 * WeldChat entity events.
 *
 * Channels emit join/leave events when membership changes; calls emit
 * started/joined/left/ended.
 */
export const CHAT_ENTITY_EVENTS = {
  chat_channel: ['created', 'updated', 'deleted', 'archived', 'joined', 'left'],
  chat_message: ['created', 'updated', 'deleted'],
  chat_call: ['started', 'joined', 'left', 'ended'],
} as const;
