export type ActivityThreshold = 'any' | '24h' | '7d' | '30d' | '90d' | 'older1y';
export type ChannelMode = 'all' | 'include' | 'exclude';
export type SortBy =
  | 'name-asc'
  | 'name-desc'
  | 'recent'
  | 'oldest'
  | 'newest-channel'
  | 'oldest-channel'
  | 'last-opened'
  | 'least-opened'
  | 'mentions-count'
  | 'unread-count';
export type NotificationLevel = 'all' | 'mentions' | 'none';
export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface DaySchedule {
  enabled: boolean;
  start: string;
  end: string;
}

export interface GroupFilterSettings {
  showOnlyUnread?: boolean;
  showOnlyMentions?: boolean;
  showOnlyActiveCalls?: boolean;
  showOnlyPinned?: boolean;
  showOnlyFavorited?: boolean;
  hideMuted?: boolean;
  showOnlyMuted?: boolean;
  hideArchived?: boolean;
  hideRead?: boolean;
  hideEmpty?: boolean;
  hideWithoutTopic?: boolean;
  hideDms?: boolean;
  activityThreshold?: ActivityThreshold;
  hideWhenEmpty?: boolean;

  channelMode?: ChannelMode;
  channelIds?: string[];

  sortBy?: SortBy;
  /** Channels matching these criteria float to the top. Each enabled flag is its own tier. */
  boostActiveCall?: boolean;
  boostPinned?: boolean;
  boostFavorite?: boolean;
  boostMentions?: boolean;
  boostUnread?: boolean;
  /** Channels matching these criteria sink to the bottom. */
  sinkRead?: boolean;
  sinkInactive?: boolean;
  sinkEmpty?: boolean;
  sinkMuted?: boolean;
  sinkArchived?: boolean;
  collapsedByDefault?: boolean;
  /** Master switch — when group is collapsed, still surface channels matching any of the peek triggers below */
  peekActiveWhenCollapsed?: boolean;
  /** Peek triggers — what counts as "active" enough to leak through a collapsed group */
  peekMentions?: boolean;
  peekUnread?: boolean;
  peekActiveCalls?: boolean;
  peekPinned?: boolean;
  peekFavorited?: boolean;
  peekRecentlyActive?: boolean;
  /** Time window for the "Recently active" peek trigger */
  peekRecentMinutes?: number;
  /** Max number of channels to surface under a collapsed group (null = no limit) */
  peekMaxItems?: number | null;
  topN?: number | null;

  notificationLevel?: NotificationLevel;
  /** Notification sound */
  notificationSound?: 'default' | 'subtle' | 'chime' | 'silent';
  /** Show desktop notifications when the app is in the background */
  desktopNotifications?: boolean;
  /** Play notification sound */
  playSound?: boolean;
  /** Vibrate on notification (mobile) */
  vibrate?: boolean;
  /** Suppress notifications during quiet hours */
  quietHoursEnabled?: boolean;
  /** Per-day quiet hours schedule. If a day is missing, no quiet hours apply that day. */
  quietHoursSchedule?: Partial<Record<DayOfWeek, DaySchedule>>;
  /** Mark all messages as read automatically when entering the group */
  autoMarkRead?: boolean;
  /** Show preview of incoming messages */
  showPreview?: boolean;
}

export const DEFAULT_GROUP_FILTER: GroupFilterSettings = {
  showOnlyUnread: false,
  showOnlyMentions: false,
  showOnlyActiveCalls: false,
  showOnlyPinned: false,
  showOnlyFavorited: false,
  hideMuted: false,
  showOnlyMuted: false,
  hideArchived: false,
  hideRead: false,
  hideEmpty: false,
  hideWithoutTopic: false,
  hideDms: false,
  activityThreshold: 'any',
  hideWhenEmpty: false,
  channelMode: 'all',
  channelIds: [],
  sortBy: 'recent',
  boostActiveCall: false,
  boostPinned: false,
  boostFavorite: false,
  boostMentions: false,
  boostUnread: false,
  sinkRead: false,
  sinkInactive: false,
  sinkEmpty: false,
  sinkMuted: false,
  sinkArchived: false,
  collapsedByDefault: false,
  peekActiveWhenCollapsed: true,
  peekMentions: true,
  peekUnread: true,
  peekActiveCalls: true,
  peekPinned: false,
  peekFavorited: false,
  peekRecentlyActive: false,
  peekRecentMinutes: 60,
  peekMaxItems: null,
  topN: null,
  notificationLevel: 'all',
  notificationSound: 'default',
  desktopNotifications: true,
  playSound: true,
  vibrate: false,
  quietHoursEnabled: false,
  quietHoursSchedule: {
    mon: { enabled: true, start: '22:00', end: '08:00' },
    tue: { enabled: true, start: '22:00', end: '08:00' },
    wed: { enabled: true, start: '22:00', end: '08:00' },
    thu: { enabled: true, start: '22:00', end: '08:00' },
    fri: { enabled: true, start: '22:00', end: '08:00' },
    sat: { enabled: true, start: '22:00', end: '09:00' },
    sun: { enabled: true, start: '22:00', end: '09:00' },
  },
  autoMarkRead: false,
  showPreview: true,
};

export type WeldchatGroupFilters = Record<string, GroupFilterSettings>;

const THRESHOLD_MS: Record<Exclude<ActivityThreshold, 'any' | 'older1y'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

interface FilterChannel {
  id: string;
  type?: string | null;
  name?: string | null;
  isMuted?: boolean | null;
  isArchived?: boolean | null;
  isPinned?: boolean | null;
  isFavorite?: boolean | null;
  topic?: string | null;
  createdAt?: string | Date | null;
  lastMessageAt?: string | Date | null;
  lastReadAt?: string | Date | null;
  unreadMentionCount?: number | null;
  unreadCount?: number | null;
  memberCount?: number | null;
  hasActiveCall?: boolean;
}

function hasUnread(ch: FilterChannel): boolean {
  if (!ch.lastMessageAt) return false;
  if (!ch.lastReadAt) return true;
  return new Date(ch.lastMessageAt).getTime() > new Date(ch.lastReadAt).getTime();
}

export function filterChannels<T extends FilterChannel>(
  channels: T[],
  settings: GroupFilterSettings,
  activeCallChannelIds: Set<string>,
): T[] {
  const ids = new Set(settings.channelIds ?? []);
  const mode = settings.channelMode ?? 'all';
  const now = Date.now();

  return channels.filter((ch) => {
    const enriched: FilterChannel = {
      ...ch,
      hasActiveCall: activeCallChannelIds.has(ch.id),
    };

    if (mode === 'include' && !ids.has(ch.id)) return false;
    if (mode === 'exclude' && ids.has(ch.id)) return false;

    if (settings.showOnlyUnread && !hasUnread(enriched)) return false;
    if (settings.showOnlyMentions && !((enriched.unreadMentionCount ?? 0) > 0)) return false;
    if (settings.showOnlyActiveCalls && !enriched.hasActiveCall) return false;
    if (settings.showOnlyPinned && !enriched.isPinned) return false;
    if (settings.showOnlyFavorited && !enriched.isFavorite) return false;
    if (settings.hideMuted && enriched.isMuted) return false;
    if (settings.showOnlyMuted && !enriched.isMuted) return false;
    if (settings.hideArchived && enriched.isArchived) return false;
    if (settings.hideRead && !hasUnread(enriched)) return false;
    if (settings.hideEmpty && !enriched.lastMessageAt) return false;
    if (settings.hideWithoutTopic && !(enriched.topic ?? '').trim()) return false;
    if (settings.hideDms && enriched.type === 'dm') return false;

    const threshold = settings.activityThreshold ?? 'any';
    if (threshold !== 'any') {
      const last = enriched.lastMessageAt ? new Date(enriched.lastMessageAt).getTime() : 0;
      const age = last ? now - last : Infinity;
      if (threshold === 'older1y') {
        if (age < 365 * 24 * 60 * 60 * 1000) return false;
      } else {
        const max = THRESHOLD_MS[threshold];
        if (age > max) return false;
      }
    }

    return true;
  });
}

function tierFor(ch: FilterChannel, s: GroupFilterSettings): number {
  const now = Date.now();
  // Boost tiers — earliest match wins (lowest tier number = topmost)
  if (s.boostActiveCall && ch.hasActiveCall) return 0;
  if (s.boostPinned && ch.isPinned) return 1;
  if (s.boostFavorite && ch.isFavorite) return 2;
  if (s.boostMentions && (ch.unreadMentionCount ?? 0) > 0) return 3;
  if (s.boostUnread && hasUnread(ch)) return 4;
  // Sink tiers — earliest match wins (highest tier number = bottommost)
  if (s.sinkArchived && ch.isArchived) return 105;
  if (s.sinkMuted && ch.isMuted) return 104;
  if (s.sinkEmpty && !ch.lastMessageAt) return 103;
  if (s.sinkInactive && ch.lastMessageAt) {
    const age = now - new Date(ch.lastMessageAt).getTime();
    if (age > 30 * 24 * 60 * 60 * 1000) return 102;
  }
  if (s.sinkRead && !hasUnread(ch)) return 101;
  return 50;
}

export function sortChannels<T extends FilterChannel>(
  channels: T[],
  settings: GroupFilterSettings,
): T[] {
  const arr = [...channels];
  const ts = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : 0);
  const primary = settings.sortBy ?? 'recent';
  const cmpPrimary = (a: T, b: T): number => {
    switch (primary) {
      case 'name-asc':
        return (a.name ?? '').localeCompare(b.name ?? '');
      case 'name-desc':
        return (b.name ?? '').localeCompare(a.name ?? '');
      case 'recent':
        return ts(b.lastMessageAt) - ts(a.lastMessageAt);
      case 'oldest':
        return ts(a.lastMessageAt) - ts(b.lastMessageAt);
      case 'newest-channel':
        return ts(b.createdAt) - ts(a.createdAt);
      case 'oldest-channel':
        return ts(a.createdAt) - ts(b.createdAt);
      case 'last-opened':
        return ts(b.lastReadAt) - ts(a.lastReadAt);
      case 'least-opened':
        return ts(a.lastReadAt) - ts(b.lastReadAt);
      case 'mentions-count':
        return (b.unreadMentionCount ?? 0) - (a.unreadMentionCount ?? 0);
      case 'unread-count':
        return (b.unreadCount ?? 0) - (a.unreadCount ?? 0);
      default:
        return 0;
    }
  };
  return arr.sort((a, b) => {
    const tA = tierFor(a, settings);
    const tB = tierFor(b, settings);
    if (tA !== tB) return tA - tB;
    return cmpPrimary(a, b);
  });
}

export function applyTopN<T>(items: T[], topN: number | null | undefined): T[] {
  if (!topN || topN <= 0) return items;
  return items.slice(0, topN);
}
