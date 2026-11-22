/**
 * The conversation an activity row is about: its channel id, or for rows the
 * server sent without one (it read the wrong key before) the id in its link,
 * `/weldchat/dm/ch_…` or `/weldchat/ch_…`.
 */
export function activityChannelId(item: {
  channelId?: string | null;
  actionUrl?: string | null;
}): string | null {
  if (item.channelId) return item.channelId;
  return /\/weldchat\/(?:dm\/)?(ch_[a-z0-9]+)/i.exec(item.actionUrl ?? '')?.[1] ?? null;
}
