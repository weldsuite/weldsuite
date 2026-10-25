import { describe, expect, it } from 'vitest';
import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import {
  coversUnread,
  isUnreadRecordChat,
  needsShowAll,
  recordGroupTypes,
  uniqueRows,
} from './record-chat-groups';
import { getRecordChatTypeInfo, recordGroupKey } from './record-chat-types';

const summaryRow = (type: string, followed: number, unread = 0, mentions = 0): RecordChatTypeSummary => ({
  type,
  label: type,
  followed,
  unread,
  mentions,
});

const notHidden = () => false;

describe('recordGroupTypes', () => {
  it('makes one group per followed type, in the order company, person, task, project, domain', () => {
    const summary = [
      summaryRow('domain', 1),
      summaryRow('task', 3),
      summaryRow('company', 12),
      summaryRow('project', 2),
      summaryRow('person', 4),
    ];
    expect(recordGroupTypes(summary, notHidden)).toEqual(['company', 'person', 'task', 'project', 'domain']);
  });

  it('leaves out types without followed chats', () => {
    const summary = [summaryRow('company', 0), summaryRow('person', 2), summaryRow('task', 0)];
    expect(recordGroupTypes(summary, notHidden)).toEqual(['person']);
  });

  it('leaves out groups the user hid', () => {
    const summary = [summaryRow('company', 5), summaryRow('task', 5)];
    const hidden = (key: string) => key === recordGroupKey('company');
    expect(recordGroupTypes(summary, hidden)).toEqual(['task']);
  });

  it('ignores types WeldChat does not list, and an unloaded summary', () => {
    expect(recordGroupTypes([summaryRow('contact', 3)], notHidden)).toEqual([]);
    expect(recordGroupTypes(undefined, notHidden)).toEqual([]);
  });
});

describe('needsShowAll', () => {
  it('adds "Show all" when the group is cut off at its top N', () => {
    expect(needsShowAll(5, 12, false)).toBe(true);
  });

  it('adds it when quiet chats were left out', () => {
    expect(needsShowAll(3, 4, false)).toBe(true);
  });

  it('leaves it out when every followed chat shows', () => {
    expect(needsShowAll(4, 4, false)).toBe(false);
  });

  it('leaves it out under a collapsed group', () => {
    expect(needsShowAll(1, 12, true)).toBe(false);
  });
});

describe('unread state', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 9, minute)).toISOString();

  it('counts a chat as unread like the server: not muted, a message after the read marker', () => {
    expect(isUnreadRecordChat({ id: 'a', lastMessageAt: at(5), lastReadAt: at(1) })).toBe(true);
    expect(isUnreadRecordChat({ id: 'b', lastMessageAt: at(5), lastReadAt: null })).toBe(true);
    expect(isUnreadRecordChat({ id: 'c', lastMessageAt: at(5), lastReadAt: at(5) })).toBe(false);
    expect(isUnreadRecordChat({ id: 'd', lastMessageAt: at(5), lastReadAt: at(1), isMuted: true })).toBe(false);
    expect(isUnreadRecordChat({ id: 'e', lastMessageAt: null })).toBe(false);
  });

  it('knows when the loaded rows hold every unread chat and mention of the summary', () => {
    const rows = [
      { id: 'a', lastMessageAt: at(5), lastReadAt: at(1) },
      { id: 'b', lastMessageAt: at(5), lastReadAt: at(5), unreadMentionCount: 2 },
    ];
    expect(coversUnread(rows, summaryRow('company', 30, 1, 2))).toBe(true);
    expect(coversUnread(rows, summaryRow('company', 30, 2, 2))).toBe(false);
    expect(coversUnread(rows, summaryRow('company', 30, 1, 3))).toBe(false);
  });
});

describe('uniqueRows', () => {
  it('keeps each chat once across pages', () => {
    const rows = uniqueRows([{ data: [{ id: 'a' }, { id: 'b' }] }, { data: [{ id: 'b' }, { id: 'c' }] }, undefined]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('record chat types', () => {
  it('describes every canonical type and none of the legacy names', () => {
    for (const type of ['company', 'person', 'task', 'project', 'domain']) {
      expect(getRecordChatTypeInfo(type)?.panelType).toBe(type);
    }
    expect(getRecordChatTypeInfo('contact')).toBeNull();
    expect(getRecordChatTypeInfo('customer')).toBeNull();
    expect(getRecordChatTypeInfo(undefined)).toBeNull();
  });
});
