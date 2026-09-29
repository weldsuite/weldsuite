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

interface ExcludeRule {
  flag: keyof GroupFilterSettings;
  excludes: (ch: FilterChannel) => boolean;
}

/** Each enabled flag excludes every channel for which `excludes` returns true. */
const EXCLUDE_RULES: ExcludeRule[] = [
  { flag: 'showOnlyUnread', excludes: (ch) => !hasUnread(ch) },
  { flag: 'showOnlyMentions', excludes: (ch) => !((ch.unreadMentionCount ?? 0) > 0) },
  { flag: 'showOnlyActiveCalls', excludes: (ch) => !ch.hasActiveCall },
  { flag: 'showOnlyPinned', excludes: (ch) => !ch.isPinned },
  { flag: 'showOnlyFavorited', excludes: (ch) => !ch.isFavorite },
  { flag: 'hideMuted', excludes: (ch) => !!ch.isMuted },
  { flag: 'showOnlyMuted', excludes: (ch) => !ch.isMuted },
  { flag: 'hideArchived', excludes: (ch) => !!ch.isArchived },
  { flag: 'hideRead', excludes: (ch) => !hasUnread(ch) },
  { flag: 'hideEmpty', excludes: (ch) => !ch.lastMessageAt },
  { flag: 'hideWithoutTopic', excludes: (ch) => !(ch.topic ?? '').trim() },
  { flag: 'hideDms', excludes: (ch) => ch.type === 'dm' },
];

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function passesChannelMode(
  id: string,
  mode: ChannelMode,
  ids: Set<string>,
): boolean {
  if (mode === 'include') return ids.has(id);
  if (mode === 'exclude') return !ids.has(id);
  return true;
}

function passesActivityThreshold(
  ch: FilterChannel,
  threshold: ActivityThreshold,
  now: number,
): boolean {
  if (threshold === 'any') return true;
  const last = ch.lastMessageAt ? new Date(ch.lastMessageAt).getTime() : 0;
  const age = last ? now - last : Infinity;
  if (threshold === 'older1y') return age >= ONE_YEAR_MS;
  return age <= THRESHOLD_MS[threshold];
}

export function filterChannels<T extends FilterChannel>(
  channels: T[],
  settings: GroupFilterSettings,
  activeCallChannelIds: Set<string>,
): T[] {
  const ids = new Set(settings.channelIds ?? []);
  const mode = settings.channelMode ?? 'all';
  const threshold = settings.activityThreshold ?? 'any';
  const now = Date.now();

  return channels.filter((ch) => {
    const enriched: FilterChannel = {
      ...ch,
      hasActiveCall: activeCallChannelIds.has(ch.id),
    };

    if (!passesChannelMode(ch.id, mode, ids)) return false;
    if (EXCLUDE_RULES.some((rule) => settings[rule.flag] && rule.excludes(enriched))) return false;
    return passesActivityThreshold(enriched, threshold, now);
  });
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface TierRule {
  flag: keyof GroupFilterSettings;
  tier: number;
  matches: (ch: FilterChannel, now: number) => boolean;
}

/**
 * Ordered tier rules, earliest match wins.
 * Boost tiers: lowest number = topmost. Sink tiers: highest number = bottommost.
 */
const TIER_RULES: TierRule[] = [
  { flag: 'boostActiveCall', tier: 0, matches: (ch) => !!ch.hasActiveCall },
  { flag: 'boostPinned', tier: 1, matches: (ch) => !!ch.isPinned },
  { flag: 'boostFavorite', tier: 2, matches: (ch) => !!ch.isFavorite },
  { flag: 'boostMentions', tier: 3, matches: (ch) => (ch.unreadMentionCount ?? 0) > 0 },
  { flag: 'boostUnread', tier: 4, matches: (ch) => hasUnread(ch) },
  { flag: 'sinkArchived', tier: 105, matches: (ch) => !!ch.isArchived },
  { flag: 'sinkMuted', tier: 104, matches: (ch) => !!ch.isMuted },
  { flag: 'sinkEmpty', tier: 103, matches: (ch) => !ch.lastMessageAt },
  {
    flag: 'sinkInactive',
    tier: 102,
    matches: (ch, now) =>
      !!ch.lastMessageAt && now - new Date(ch.lastMessageAt).getTime() > THIRTY_DAYS_MS,
  },
  { flag: 'sinkRead', tier: 101, matches: (ch) => !hasUnread(ch) },
];

function tierFor(ch: FilterChannel, s: GroupFilterSettings): number {
  const now = Date.now();
  const rule = TIER_RULES.find((r) => s[r.flag] && r.matches(ch, now));
  return rule ? rule.tier : 50;
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
