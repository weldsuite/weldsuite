import { describe, expect, it } from 'vitest';
import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import {
  parseRecordChatsSearch,
  permittedRecordChatTypes,
  RECORD_CHAT_FILTER_LABEL_KEYS,
  RECORD_CHAT_FILTERS,
  recordChatsEmptyKeys,
  resolveRecordChatsType,
} from './record-chats-page';
import { getRecordChatTypeInfo, RECORD_CHAT_TYPES, recordChatsPageHref } from './record-chat-types';

const summaryRow = (type: string): RecordChatTypeSummary => ({ type, label: type, followed: 0, unread: 0, mentions: 0 });

/** The string at a dotted key, or undefined when the path does not exist. */
function lookup(locale: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);
}

describe('parseRecordChatsSearch', () => {
  it('keeps a known type and filter', () => {
    expect(parseRecordChatsSearch({ type: 'company', filter: 'unread' })).toEqual({ type: 'company', filter: 'unread' });
  });

  it('drops unknown and legacy types', () => {
    expect(parseRecordChatsSearch({ type: 'contact' })).toEqual({});
    expect(parseRecordChatsSearch({ type: 'ticket' })).toEqual({});
    expect(parseRecordChatsSearch({ type: 42 })).toEqual({});
  });

  it('drops an unknown filter and leaves the default one out', () => {
    expect(parseRecordChatsSearch({ filter: 'archived' })).toEqual({});
    expect(parseRecordChatsSearch({ filter: 'following' })).toEqual({});
    expect(parseRecordChatsSearch({ filter: 'all' })).toEqual({ filter: 'all' });
  });

  it('reads the type of every "Show all" link back', () => {
    for (const type of RECORD_CHAT_TYPES) {
      const url = new URL(recordChatsPageHref(type), 'https://app.test');
      expect(url.pathname).toBe('/weldchat/records');
      expect(parseRecordChatsSearch(Object.fromEntries(url.searchParams))).toEqual({ type });
    }
  });
});

describe('permittedRecordChatTypes', () => {
  it('is unknown until the summary has loaded', () => {
    expect(permittedRecordChatTypes(undefined)).toBeNull();
  });

  it('lists the types the summary has, in tab order', () => {
    const summary = [summaryRow('domain'), summaryRow('task'), summaryRow('company')];
    expect(permittedRecordChatTypes(summary)).toEqual(['company', 'task', 'domain']);
  });

  it('gives no tab to a type the caller has no permission for, nor to types WeldChat does not list', () => {
    expect(permittedRecordChatTypes([summaryRow('person'), summaryRow('contact')])).toEqual(['person']);
    expect(permittedRecordChatTypes([])).toEqual([]);
  });
});

describe('resolveRecordChatsType', () => {
  it('opens the All tab when no type is asked for', () => {
    expect(resolveRecordChatsType(undefined, ['company'])).toBeUndefined();
  });

  it('opens the asked-for type when the caller may list it', () => {
    expect(resolveRecordChatsType('task', ['company', 'task'])).toBe('task');
  });

  it('falls back to All for a type the caller has no permission for', () => {
    expect(resolveRecordChatsType('company', ['task', 'project'])).toBeUndefined();
  });

  it('keeps the asked-for type while the permissions are still loading', () => {
    expect(resolveRecordChatsType('domain', null)).toBe('domain');
  });
});

describe('record chats page copy', () => {
  it.each([
    ['en', en],
    ['nl', nl],
  ])('has every filter label and empty state in %s', (_name, locale) => {
    for (const filter of RECORD_CHAT_FILTERS) {
      expect(typeof lookup(locale, RECORD_CHAT_FILTER_LABEL_KEYS[filter])).toBe('string');
      const empty = recordChatsEmptyKeys(filter);
      expect(typeof lookup(locale, empty.title)).toBe('string');
      expect(typeof lookup(locale, empty.description)).toBe('string');
    }
  });

  it.each([
    ['en', en],
    ['nl', nl],
  ])('has a tab label for every record type in %s', (_name, locale) => {
    for (const type of RECORD_CHAT_TYPES) {
      expect(typeof lookup(locale, getRecordChatTypeInfo(type)!.groupLabelKey)).toBe('string');
    }
  });
});
