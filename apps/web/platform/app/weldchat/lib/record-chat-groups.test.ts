import { describe, expect, it, vi } from 'vitest';
import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import {
  coversUnread,
  isUnreadRecordChat,
  needsShowAll,
  recordGroupTypes,
  uniqueRows,
} from './record-chat-groups';
import { BOOKS_RECORD_CHAT_TYPES, getRecordChatTypeInfo, openRecordPanel, recordGroupKey } from './record-chat-types';

/** Whether the edition has questions to the accountant (`books-questions`); Global has not. */
const edition = vi.hoisted(() => ({ questions: true }));
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return {
    ...actual,
    isFeatureAvailable: (feature: Parameters<typeof actual.isFeatureAvailable>[0]) =>
      feature === 'books-questions' ? edition.questions : actual.isFeatureAvailable(feature),
  };
});

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

describe('WeldBooks record chat types (books-questions)', () => {
  const BOOKS_SUMMARY = [
    summaryRow('invoice', 2),
    summaryRow('bill', 1),
    summaryRow('bank_transaction', 4),
    summaryRow('accounting_document', 1),
    summaryRow('vat_return', 1),
    summaryRow('accounting_contact', 3),
  ];

  it('gives each of the six types a group, after the base ones, in a fixed order', () => {
    edition.questions = true;
    expect(recordGroupTypes([summaryRow('company', 1), ...BOOKS_SUMMARY.reverse()], notHidden)).toEqual([
      'company',
      ...BOOKS_RECORD_CHAT_TYPES,
    ]);
  });

  it('shows the icon, the labels and where the record opens for every type', () => {
    edition.questions = true;
    for (const type of BOOKS_RECORD_CHAT_TYPES) {
      const info = getRecordChatTypeInfo(type);
      expect(info).not.toBeNull();
      expect(info?.icon).toBeTruthy();
      expect(info?.groupLabelKey).toBe(`sweep.weldchat.recordChats.groups.${type}`);
      expect(info?.labelKey).toBe(`sweep.weldchat.recordChats.types.${type}`);
      expect(info?.openLabelKey).toBe(`sweep.weldchat.recordChats.open.${type}`);
    }
    expect(getRecordChatTypeInfo('invoice')?.panelType).toBe('invoice');
    expect(getRecordChatTypeInfo('bill')?.panelType).toBe('bill');
    expect(getRecordChatTypeInfo('bank_transaction')?.panelType).toBe('bank_transaction');
    expect(getRecordChatTypeInfo('vat_return')?.panelType).toBe('vat_return');
    expect(getRecordChatTypeInfo('accounting_contact')?.panelType).toBe('weldbooks_contact');
  });

  it('opens a panel for a record, and the documents page for an inbox document', () => {
    edition.questions = true;
    const open = vi.fn();
    const push = vi.fn();
    openRecordPanel(open, 'accounting_contact', 'prt_1', push);
    expect(open).toHaveBeenCalledWith({ type: 'weldbooks_contact', id: 'prt_1' });
    openRecordPanel(open, 'accounting_document', 'doc 1', push);
    expect(push).toHaveBeenCalledWith('/weldbooks/documents?document=doc%201');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves them out where the edition has no questions (Global)', () => {
    edition.questions = false;
    expect(recordGroupTypes(BOOKS_SUMMARY, notHidden)).toEqual([]);
    for (const type of BOOKS_RECORD_CHAT_TYPES) expect(getRecordChatTypeInfo(type)).toBeNull();
    edition.questions = true;
  });
});
