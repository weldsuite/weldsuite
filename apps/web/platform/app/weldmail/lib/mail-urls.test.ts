import { describe, expect, it } from 'vitest';
import { buildMailItemUrl, buildMailListUrl, buildMailSearch, mailFolderPath, parseMailSearch } from './mail-urls';

describe('buildMailSearch', () => {
  it('omits the query string on page 1 with no account', () => {
    expect(buildMailSearch({ page: 1 })).toBe('');
    expect(buildMailSearch({})).toBe('');
  });

  it('includes page when greater than 1', () => {
    expect(buildMailSearch({ page: 2 })).toBe('?page=2');
    expect(buildMailSearch({ page: 7 })).toBe('?page=7');
  });

  it('includes unified accountId and combines it with page', () => {
    expect(buildMailSearch({ accountId: 'acc_1' })).toBe('?accountId=acc_1');
    expect(buildMailSearch({ accountId: 'acc_1', page: 3 })).toBe(
      '?accountId=acc_1&page=3',
    );
  });
});

describe('mailFolderPath', () => {
  it('lowercases inbox and other folders', () => {
    expect(mailFolderPath('INBOX')).toBe('inbox');
    expect(mailFolderPath('Sent')).toBe('sent');
  });
});

describe('buildMailItemUrl', () => {
  it('keeps the current page when opening a per-account message', () => {
    expect(
      buildMailItemUrl({
        isUnified: false,
        accountId: 'acc_1',
        folder: 'INBOX',
        messageId: 'msg_9',
        page: 2,
      }),
    ).toBe('/weldmail/acc_1/inbox/msg_9?page=2');
  });

  it('omits page on the first page', () => {
    expect(
      buildMailItemUrl({
        isUnified: false,
        accountId: 'acc_1',
        folder: 'inbox',
        messageId: 'msg_9',
        page: 1,
      }),
    ).toBe('/weldmail/acc_1/inbox/msg_9');
  });

  it('keeps page and thread accountId in unified inbox', () => {
    expect(
      buildMailItemUrl({
        isUnified: true,
        accountId: 'unified',
        folder: 'inbox',
        messageId: 'msg_9',
        threadAccountId: 'acc_2',
        page: 4,
      }),
    ).toBe('/weldmail/unified/inbox/msg_9?accountId=acc_2&page=4');
  });
});

describe('buildMailListUrl', () => {
  it('uses a bare path for page 1 and ?page= for later pages', () => {
    expect(
      buildMailListUrl({
        isUnified: false,
        accountId: 'acc_1',
        folder: 'inbox',
        page: 1,
      }),
    ).toBe('/weldmail/acc_1/inbox');
    expect(
      buildMailListUrl({
        isUnified: true,
        accountId: 'unified',
        folder: 'sent',
        page: 2,
      }),
    ).toBe('/weldmail/unified/sent?page=2');
  });
});

describe('parseMailSearch', () => {
  it('keeps page only when it is greater than 1', () => {
    expect(parseMailSearch({ page: '2' })).toEqual({ page: 2, accountId: undefined });
    expect(parseMailSearch({ page: 3 })).toEqual({ page: 3, accountId: undefined });
    expect(parseMailSearch({ page: '1' })).toEqual({ page: undefined, accountId: undefined });
    expect(parseMailSearch({ page: 'nope' })).toEqual({ page: undefined, accountId: undefined });
    expect(parseMailSearch({ page: 0 })).toEqual({ page: undefined, accountId: undefined });
  });

  it('keeps unified accountId', () => {
    expect(parseMailSearch({ accountId: 'acc_1', page: '4' })).toEqual({
      page: 4,
      accountId: 'acc_1',
    });
  });
});
