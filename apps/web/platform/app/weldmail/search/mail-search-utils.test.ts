import { describe, expect, it } from 'vitest';
import type { MailMessageRow } from '@weldsuite/app-api-client';
import {
  MAIL_SEARCH_PAGE_SIZE,
  buildMailSearchParams,
  normalizeSearchQuery,
  pickResultFolder,
  toMailSearchResult,
} from './mail-search-utils';

const off = { hasAttachments: false, isStarred: false };

function row(overrides: Partial<MailMessageRow>): MailMessageRow {
  return {
    id: 'msg_1',
    accountId: 'acc_1',
    from: { email: 'ann@example.com', name: 'Ann' },
    subject: 'Quarterly report',
    preview: 'Numbers attached',
    receivedDate: '2026-10-01T10:00:00.000Z',
    sentDate: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    isRead: false,
    isStarred: true,
    hasAttachments: true,
    labels: ['INBOX'],
    ...overrides,
  } as MailMessageRow;
}

describe('normalizeSearchQuery', () => {
  it('trims whitespace', () => {
    expect(normalizeSearchQuery('  invoice ')).toBe('invoice');
    expect(normalizeSearchQuery('   ')).toBe('');
  });
});

describe('buildMailSearchParams', () => {
  it('sends the trimmed query and page size, and no account scope', () => {
    expect(buildMailSearchParams({ query: ' foo ', filters: off })).toEqual({
      search: 'foo',
      limit: MAIL_SEARCH_PAGE_SIZE,
    });
  });

  it('only sends boolean filters that are switched on', () => {
    const params = buildMailSearchParams({
      query: 'foo',
      filters: { hasAttachments: true, isStarred: false },
    });
    expect(params.hasAttachments).toBe(true);
    expect(params).not.toHaveProperty('isStarred');
  });

  it('forwards the cursor for the next page', () => {
    expect(buildMailSearchParams({ query: 'foo', filters: off, cursor: 'msg_9' }).cursor).toBe('msg_9');
  });
});

describe('pickResultFolder', () => {
  it('maps system labels to a mailbox slug', () => {
    expect(pickResultFolder(['SENT'])).toBe('sent');
    expect(pickResultFolder(['INBOX', 'STARRED'])).toBe('inbox');
    expect(pickResultFolder(['trash'])).toBe('trash');
  });

  it('prefers trash over the other labels', () => {
    expect(pickResultFolder(['INBOX', 'TRASH'])).toBe('trash');
  });

  it('falls back to all mail', () => {
    expect(pickResultFolder([])).toBe('all');
    expect(pickResultFolder(null)).toBe('all');
    expect(pickResultFolder(['Clients'])).toBe('all');
  });
});

describe('toMailSearchResult', () => {
  it('links to the message in its own mailbox', () => {
    const result = toMailSearchResult(row({ labels: ['SENT'] }));
    expect(result.href).toBe('/weldmail/acc_1/sent/msg_1');
    expect(result.folder).toBe('sent');
  });

  it('prefers the sender name, then the address', () => {
    expect(toMailSearchResult(row({})).from).toBe('Ann');
    expect(toMailSearchResult(row({ from: { email: 'a@b.c', name: null } })).from).toBe('a@b.c');
    expect(toMailSearchResult(row({ from: null })).from).toBe('');
  });

  it('survives missing optional fields', () => {
    const result = toMailSearchResult(row({ subject: null, preview: null }));
    expect(result.subject).toBe('');
    expect(result.preview).toBe('');
    expect(result.date).toBeInstanceOf(Date);
  });
});
