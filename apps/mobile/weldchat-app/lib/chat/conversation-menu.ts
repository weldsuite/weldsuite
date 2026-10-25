/**
 * What the long-press menu on a channel or conversation needs from the API:
 * your own membership (mute and notification level) and the web link.
 */
import { PLATFORM_URL, appApiClient } from '@/services/app-api';

export type NotificationLevel = 'all' | 'mentions' | 'none';

export interface MyMembership {
  id: string;
  isMuted: boolean;
  notificationPreference: NotificationLevel;
}

/**
 * The conversation in the web app, as its sidebar links it: a channel by id,
 * a 1:1 conversation by the other person, a group conversation by id.
 */
export function conversationWebUrl(
  target: { kind: 'channel'; id: string } | { kind: 'dm'; id: string; peerUserId?: string | null },
  origin: string = PLATFORM_URL,
): string {
  if (target.kind === 'channel') return `${origin}/weldchat/${target.id}`;
  if (target.peerUserId) return `${origin}/weldchat/dm/${target.peerUserId}`;
  return `${origin}/weldchat/dm/group/${target.id}`;
}

// One request per conversation per session: the menu reads it again on every
// long-press, and every change below keeps it current.
const memberships = new Map<string, MyMembership>();

export function cachedMembership(channelId: string): MyMembership | undefined {
  return memberships.get(channelId);
}

export async function loadMembership(channelId: string, userId: string): Promise<MyMembership | null> {
  const cached = memberships.get(channelId);
  if (cached) return cached;
  const res = await appApiClient.get<{ data: MyMembership[] }>(
    `/channel-members?channelId=${encodeURIComponent(channelId)}&userId=${encodeURIComponent(userId)}`,
  );
  const row = res.data?.[0];
  if (!row) return null;
  const membership: MyMembership = {
    id: row.id,
    isMuted: !!row.isMuted,
    notificationPreference: row.notificationPreference ?? 'all',
  };
  memberships.set(channelId, membership);
  return membership;
}

/**
 * Mute or the notification level, on your own membership row. This route
 * only needs `channels:read`, so it works for every member.
 */
export async function updateMembership(
  channelId: string,
  userId: string,
  patch: Partial<Pick<MyMembership, 'isMuted' | 'notificationPreference'>>,
): Promise<void> {
  const membership = await loadMembership(channelId, userId);
  if (!membership) throw new Error('Not a member of this conversation');
  await appApiClient.patch(`/channel-members/${membership.id}`, patch);
  memberships.set(channelId, { ...membership, ...patch });
}
