/** Direct messages as the DM list and Home render them. */

export interface DmMember {
  userId: string;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
}

export interface DmChannel {
  id: string;
  name: string;
  picture?: string | null;
  type: string;
  isGroup?: boolean;
  otherMembers?: DmMember[];
  isMuted?: boolean;
  isPinned?: boolean;
  hasUnread?: boolean;
  unreadCount?: number;
  lastMessagePreview?: string | null;
  lastMessageAt?: string;
}

/**
 * Map a raw app-api `/chat-dm` row into the shape the screens render.
 * Mirrors the platform sidebar derivation (use-weldchat-sidebar-items.tsx):
 * display name + avatar come from `otherMembers`, unread from
 * lastMessageAt vs the current user's lastReadAt, pin from metadata.pinnedBy.
 */
export function mapDm(dm: any, currentUserId: string | undefined): DmChannel {
  const otherMembers: DmMember[] = (dm.otherMembers ?? []).filter((m: any) => m?.userId);
  const isGroup = otherMembers.length > 1;
  const first = otherMembers[0];
  const displayName = isGroup
    ? otherMembers.map((m) => m.name || m.email || 'Unknown').join(', ') || dm.name || 'Group'
    : first?.name || first?.email || dm.name || 'Direct Message';
  const hasUnread =
    !!dm.lastMessageAt && (!dm.lastReadAt || new Date(dm.lastMessageAt) > new Date(dm.lastReadAt));
  const pinnedBy: string[] = Array.isArray(dm.metadata?.pinnedBy) ? dm.metadata.pinnedBy : [];
  return {
    id: dm.id,
    type: dm.type,
    name: displayName,
    isGroup,
    otherMembers,
    picture: isGroup ? null : first?.picture ?? null,
    isMuted: !!dm.isMuted,
    isPinned: currentUserId ? pinnedBy.includes(currentUserId) : false,
    hasUnread,
    unreadCount: dm.unreadMentionCount || 0,
    lastMessagePreview: dm.lastMessagePreview ?? null,
    lastMessageAt: dm.lastMessageAt ?? undefined,
  };
}

export function formatMessageTime(dateStr?: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDate = new Date(date);
  startOfDate.setHours(0, 0, 0, 0);

  const dayDiff = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86400000);

  if (dayDiff <= 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
}
