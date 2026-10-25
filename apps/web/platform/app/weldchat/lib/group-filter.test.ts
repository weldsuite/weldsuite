import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GROUP_FILTER,
  RECORD_GROUP_FILTER,
  filterChannels,
  getGroupDefaults,
  selectGroupRows,
  selectPeekRows,
} from './group-filter';

const NOW = Date.UTC(2026, 9, 25, 12, 0);
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

interface Chat {
  id: string;
  lastMessageAt?: string | null;
  lastReadAt?: string | null;
  isMuted?: boolean;
  unreadMentionCount?: number;
}

/** A chat the user has read up to its last message. */
const read = (id: string, days: number): Chat => ({ id, lastMessageAt: daysAgo(days), lastReadAt: daysAgo(days) });
/** A chat with a message after the user's read marker. */
const unread = (id: string, days: number): Chat => ({ id, lastMessageAt: daysAgo(days), lastReadAt: daysAgo(days + 1) });

const rowsFor = (chats: Chat[]) => chats.map((c) => ({ id: c.id, title: c.id }));
const ids = (rows: Array<{ id?: string }>) => rows.map((r) => r.id);
const noCalls = new Set<string>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getGroupDefaults', () => {
  it('gives record chat groups their own defaults', () => {
    expect(getGroupDefaults('record:company')).toBe(RECORD_GROUP_FILTER);
    expect(RECORD_GROUP_FILTER).toMatchObject({
      sortBy: 'recent',
      boostMentions: true,
      boostUnread: true,
      topN: 5,
      activityThreshold: '30d',
      peekActiveWhenCollapsed: true,
      peekUnread: true,
      peekMentions: true,
      hideWhenEmpty: true,
    });
  });

  it('keeps today\'s defaults for channels and DMs', () => {
    expect(getGroupDefaults('dm')).toBe(DEFAULT_GROUP_FILTER);
    expect(getGroupDefaults('section:default')).toBe(DEFAULT_GROUP_FILTER);
    expect(getGroupDefaults('channel:ch_1')).toBe(DEFAULT_GROUP_FILTER);
    expect(DEFAULT_GROUP_FILTER).toMatchObject({ topN: null, activityThreshold: 'any', hideWhenEmpty: false });
  });
});

describe('activity threshold', () => {
  const settings = { ...DEFAULT_GROUP_FILTER, activityThreshold: '30d' as const };

  it('drops chats with no message in the window', () => {
    const kept = filterChannels([read('recent', 2), read('quiet', 45), { id: 'empty' }], settings, noCalls);
    expect(ids(kept)).toEqual(['recent']);
  });

  it('never hides a quiet chat with unread messages or mentions', () => {
    const mentioned: Chat = { ...read('mentioned', 60), unreadMentionCount: 2 };
    const kept = filterChannels([unread('unread', 60), mentioned, read('quiet', 60)], settings, noCalls);
    expect(ids(kept)).toEqual(['unread', 'mentioned']);
  });

  it('still hides a quiet muted chat, unless it mentions the user', () => {
    const muted: Chat = { ...unread('muted', 60), isMuted: true };
    const mutedMention: Chat = { ...muted, id: 'muted-mention', unreadMentionCount: 1 };
    expect(ids(filterChannels([muted, mutedMention], settings, noCalls))).toEqual(['muted-mention']);
  });

  it('leaves the "older than a year" filter as it was', () => {
    const older = { ...DEFAULT_GROUP_FILTER, activityThreshold: 'older1y' as const };
    expect(ids(filterChannels([unread('new-unread', 3), read('old', 400)], older, noCalls))).toEqual(['old']);
  });
});

describe('selectGroupRows with the record group defaults', () => {
  it('shows the five most recent chats', () => {
    const chats = [1, 2, 3, 4, 5, 6, 7].map((d) => read(`c${d}`, d));
    const rows = selectGroupRows(rowsFor(chats), chats, RECORD_GROUP_FILTER, undefined, noCalls);
    expect(ids(rows)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('puts mentions, then unread chats, ahead of more recent read ones', () => {
    const chats = [
      read('read-new', 1),
      read('read-newer', 0.5),
      unread('unread-old', 20),
      { ...read('mention-old', 25), unreadMentionCount: 1 },
      read('read-mid', 3),
      read('read-old', 10),
    ];
    const rows = selectGroupRows(rowsFor(chats), chats, RECORD_GROUP_FILTER, undefined, noCalls);
    expect(ids(rows)).toEqual(['mention-old', 'unread-old', 'read-newer', 'read-new', 'read-mid']);
  });

  it('keeps an unread chat that is older than the activity window', () => {
    const chats = [read('quiet', 90), unread('quiet-unread', 90), read('recent', 1)];
    const rows = selectGroupRows(rowsFor(chats), chats, RECORD_GROUP_FILTER, undefined, noCalls);
    expect(ids(rows)).toEqual(['quiet-unread', 'recent']);
  });

  it('follows the user\'s drag-and-drop order, then cuts at five', () => {
    const chats = [1, 2, 3, 4, 5, 6].map((d) => read(`c${d}`, d));
    const rows = selectGroupRows(rowsFor(chats), chats, RECORD_GROUP_FILTER, ['c6', 'c3'], noCalls);
    expect(ids(rows)).toEqual(['c6', 'c3', 'c1', 'c2', 'c4']);
  });
});

describe('selectPeekRows (collapsed group)', () => {
  it('still surfaces unread chats and mentions', () => {
    const chats = [read('read', 1), unread('unread', 2), { ...read('mention', 3), unreadMentionCount: 1 }];
    const rows = selectPeekRows(rowsFor(chats), chats, RECORD_GROUP_FILTER, noCalls, NOW);
    expect(ids(rows)).toEqual(['unread', 'mention']);
  });

  it('shows nothing when peeking is off', () => {
    const chats = [unread('unread', 2)];
    const settings = { ...RECORD_GROUP_FILTER, peekActiveWhenCollapsed: false };
    expect(selectPeekRows(rowsFor(chats), chats, settings, noCalls, NOW)).toEqual([]);
  });
});
