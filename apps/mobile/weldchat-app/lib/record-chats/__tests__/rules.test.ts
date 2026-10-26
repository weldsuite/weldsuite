import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import {
  QUIET_AFTER_MS,
  buildRecordGroups,
  changedSummaryTypes,
  coversUnread,
  isQuietRecordChat,
  isRecordChatType,
  isUnreadRecordChat,
  needsAttention,
  patchRecordChats,
  recordChatName,
  recordRefreshFor,
  sortRecordChats,
  uniqueRows,
} from '../rules';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

interface Row {
  id: string;
  entityType: string;
  isMuted?: boolean;
  lastMessageAt?: string | null;
  lastReadAt?: string | null;
  unreadMentionCount?: number;
}

/** A read chat with its last message `age` ago. */
function chat(id: string, age: number, extra: Partial<Row> = {}): Row {
  return { id, entityType: 'company', lastMessageAt: ago(age), lastReadAt: ago(age), ...extra };
}

/** A chat with a message after the read marker. */
function unread(id: string, age: number, extra: Partial<Row> = {}): Row {
  return chat(id, age, { lastReadAt: ago(age + DAY), ...extra });
}

function summary(type: string, followed: number, unreadCount = 0, mentions = 0): RecordChatTypeSummary {
  return { type, label: type, followed, unread: unreadCount, mentions };
}

describe('record chat names and types', () => {
  it('knows the five canonical types and nothing else', () => {
    for (const type of ['company', 'person', 'task', 'project', 'domain']) expect(isRecordChatType(type)).toBe(true);
    expect(isRecordChatType('contact')).toBe(false);
    expect(isRecordChatType('customer')).toBe(false);
    expect(isRecordChatType(null)).toBe(false);
  });

  it('names a chat after its record, else its channel', () => {
    expect(recordChatName({ entityDisplayName: 'Acme', name: 'entity-company-1' })).toBe('Acme');
    expect(recordChatName({ entityDisplayName: null, name: 'entity-company-1' })).toBe('entity-company-1');
  });
});

describe('unread and quiet chats', () => {
  it('counts a chat as unread like the server: not muted, a message after the read marker', () => {
    expect(isUnreadRecordChat(unread('a', DAY))).toBe(true);
    expect(isUnreadRecordChat(chat('a', DAY, { lastReadAt: null }))).toBe(true);
    expect(isUnreadRecordChat(chat('a', DAY))).toBe(false);
    expect(isUnreadRecordChat(unread('a', DAY, { isMuted: true }))).toBe(false);
    expect(isUnreadRecordChat({ id: 'a', lastMessageAt: null, lastReadAt: null })).toBe(false);
  });

  it('drops a chat with no message in 30 days', () => {
    expect(isQuietRecordChat(chat('a', QUIET_AFTER_MS - DAY), NOW)).toBe(false);
    expect(isQuietRecordChat(chat('a', QUIET_AFTER_MS + DAY), NOW)).toBe(true);
  });

  it('drops a followed chat nobody wrote in yet', () => {
    expect(isQuietRecordChat({ id: 'a', lastMessageAt: null, lastReadAt: null }, NOW)).toBe(true);
  });

  it('never drops a chat with unread messages or mentions', () => {
    expect(isQuietRecordChat(unread('a', 90 * DAY), NOW)).toBe(false);
    expect(isQuietRecordChat(chat('a', 90 * DAY, { unreadMentionCount: 1 }), NOW)).toBe(false);
    expect(isQuietRecordChat(unread('a', 90 * DAY, { isMuted: true, unreadMentionCount: 2 }), NOW)).toBe(false);
  });

  it('lets an old muted chat go quiet even with unread messages', () => {
    const muted = unread('a', 90 * DAY, { isMuted: true });
    expect(needsAttention(muted)).toBe(false);
    expect(isQuietRecordChat(muted, NOW)).toBe(true);
  });
});

describe('sortRecordChats', () => {
  it('puts mentions first, then unread chats, then the most recent', () => {
    const rows = [
      chat('old', 5 * DAY),
      chat('new', 1 * DAY),
      unread('unread', 4 * DAY),
      chat('mention', 6 * DAY, { unreadMentionCount: 1 }),
      unread('unread-newer', 2 * DAY),
    ];
    expect(sortRecordChats(rows).map((r) => r.id)).toEqual(['mention', 'unread-newer', 'unread', 'new', 'old']);
  });
});

describe('buildRecordGroups', () => {
  it('makes one group per followed type in the fixed order', () => {
    const groups = buildRecordGroups(
      [summary('domain', 1), summary('company', 1), summary('task', 0), summary('person', 2)],
      {
        domain: [chat('d1', DAY)],
        company: [chat('c1', DAY)],
        person: [chat('p1', DAY), chat('p2', 2 * DAY)],
      },
      { now: NOW },
    );
    expect(groups.map((g) => g.type)).toEqual(['company', 'person', 'domain']);
  });

  it('skips a type the user follows nothing of, even with rows cached', () => {
    const groups = buildRecordGroups([summary('company', 0)], { company: [chat('c1', DAY)] }, { now: NOW });
    expect(groups).toEqual([]);
  });

  it('shows the top 5 and a "Show all" row when the user follows more', () => {
    const rows = Array.from({ length: 8 }, (_, i) => chat(`c${i}`, (i + 1) * DAY));
    const [group] = buildRecordGroups([summary('company', 8)], { company: rows }, { now: NOW });
    expect(group.rows.map((r) => r.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(group.showAll).toBe(true);
  });

  it('has no "Show all" row when every followed chat is listed', () => {
    const [group] = buildRecordGroups([summary('company', 2)], { company: [chat('a', DAY), chat('b', DAY)] }, { now: NOW });
    expect(group.showAll).toBe(false);
  });

  it('leaves quiet chats out but keeps old unread ones, and offers "Show all" for the rest', () => {
    const rows = [chat('recent', DAY), chat('quiet', 45 * DAY), unread('old-unread', 60 * DAY)];
    const [group] = buildRecordGroups([summary('company', 3, 1)], { company: rows }, { now: NOW });
    expect(group.rows.map((r) => r.id)).toEqual(['old-unread', 'recent']);
    expect(group.showAll).toBe(true);
  });

  it('hides a group whose chats are all quiet', () => {
    const groups = buildRecordGroups([summary('company', 2)], { company: [chat('a', 40 * DAY), chat('b', 50 * DAY)] }, { now: NOW });
    expect(groups).toEqual([]);
  });

  it('shows only unread chats and mentions under a collapsed group, without "Show all"', () => {
    const rows = [chat('read', DAY), unread('unread', 2 * DAY), chat('mention', 3 * DAY, { unreadMentionCount: 2 })];
    const [group] = buildRecordGroups([summary('company', 9, 1, 2)], { company: rows }, {
      now: NOW,
      isCollapsed: (type) => type === 'company',
    });
    expect(group.collapsed).toBe(true);
    expect(group.rows.map((r) => r.id)).toEqual(['mention', 'unread']);
    expect(group.showAll).toBe(false);
  });

  it('passes the summary counts on for the header', () => {
    const [group] = buildRecordGroups([summary('task', 4, 2, 3)], { task: [chat('t', DAY)] }, { now: NOW });
    expect(group).toMatchObject({ followed: 4, unread: 2, mentions: 3 });
  });
});

describe('loading pages', () => {
  it('needs another page while the summary counts unread chats the rows lack', () => {
    const rows = [unread('a', DAY), chat('b', DAY, { unreadMentionCount: 1 })];
    expect(coversUnread(rows, summary('company', 30, 1, 1))).toBe(true);
    expect(coversUnread(rows, summary('company', 30, 2, 1))).toBe(false);
    expect(coversUnread(rows, summary('company', 30, 1, 3))).toBe(false);
  });

  it('does not count a muted chat as unread, like the summary', () => {
    expect(coversUnread([unread('a', DAY, { isMuted: true })], summary('company', 1, 1))).toBe(false);
  });

  it('keeps each chat once across pages', () => {
    expect(uniqueRows([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('patchRecordChats', () => {
  const snapshot = () => ({
    summary: [summary('company', 3, 1, 2), summary('task', 1)],
    rows: {
      company: [unread('a', DAY, { unreadMentionCount: 2 }), chat('b', DAY), chat('c', DAY)],
      task: [{ ...chat('t', DAY), entityType: 'task' }],
    },
  });

  it('removes an unfollowed chat and its counts', () => {
    const next = patchRecordChats(snapshot(), 'a', { isFollowing: false }, NOW);
    expect(next.rows.company!.map((r) => r.id)).toEqual(['b', 'c']);
    expect(next.summary![0]).toMatchObject({ followed: 2, unread: 0, mentions: 0 });
    expect(next.summary![1]).toMatchObject({ followed: 1 });
  });

  it('marks a chat read', () => {
    const next = patchRecordChats(snapshot(), 'a', { hasUnread: false }, NOW);
    const row = next.rows.company![0];
    expect(isUnreadRecordChat(row)).toBe(false);
    expect(row.unreadMentionCount).toBe(0);
    expect(next.summary![0]).toMatchObject({ followed: 3, unread: 0, mentions: 0 });
  });

  it('takes a muted chat out of the unread count but keeps its mentions', () => {
    const next = patchRecordChats(snapshot(), 'a', { isMuted: true }, NOW);
    expect(next.rows.company![0].isMuted).toBe(true);
    expect(next.summary![0]).toMatchObject({ unread: 0, mentions: 2 });
  });

  it('leaves the snapshot alone for a chat it does not hold', () => {
    const before = snapshot();
    expect(patchRecordChats(before, 'zzz', { isFollowing: false }, NOW)).toBe(before);
  });
});

describe('changedSummaryTypes', () => {
  it('lists the types whose counts moved, appeared or went away', () => {
    const before = [summary('company', 2, 1), summary('task', 1), summary('domain', 1)];
    const after = [summary('company', 2, 2), summary('task', 1), summary('person', 1)];
    expect(changedSummaryTypes(before, after)).toEqual(['company', 'person', 'domain']);
  });

  it('lists every type on the first load', () => {
    expect(changedSummaryTypes(null, [summary('company', 0), summary('task', 1)])).toEqual(['company', 'task']);
  });
});

describe('recordRefreshFor', () => {
  const known = { recordChatIds: new Set(['rec']), channelIds: new Set(['chan', 'dm']) };

  it('reloads the groups for a new follow', () => {
    expect(recordRefreshFor({ event: 'channel_new', data: { channelId: 'x' } }, known)).toBe('all');
  });

  it('reloads the groups for a message in a record chat they hold', () => {
    expect(recordRefreshFor({ event: 'unread_update', data: { channelId: 'rec' } }, known)).toBe('all');
    expect(recordRefreshFor({ event: 'mention', data: { channelId: 'rec' } }, known)).toBe('all');
  });

  it('leaves the groups alone for a channel or DM Home already lists', () => {
    expect(recordRefreshFor({ event: 'unread_update', data: { channelId: 'chan' } }, known)).toBe('none');
    expect(recordRefreshFor({ event: 'unread_update', data: { channelId: 'dm' } }, known)).toBe('none');
    expect(recordRefreshFor({ event: 'dm_new', data: { channelId: 'new-dm' } }, known)).toBe('none');
  });

  it('checks only the summary for a chat it does not know', () => {
    expect(recordRefreshFor({ event: 'unread_update', data: { channelId: 'other' } }, known)).toBe('summary');
    expect(recordRefreshFor({ event: 'created', data: {} }, known)).toBe('summary');
    expect(recordRefreshFor(undefined, known)).toBe('summary');
  });
});
