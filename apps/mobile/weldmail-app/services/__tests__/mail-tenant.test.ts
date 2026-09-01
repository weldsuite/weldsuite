import {
  mergeByDate,
  normalizePersonalMessage,
  rememberPersonalAccounts,
  isPersonalAccountId,
  isPersonalMessage,
  isPersonalAccount,
} from '../mail-tenant';
import type { MailMessage } from '@weldsuite/personal-api-client';

function personalRow(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'msg_personal_1',
    personalAccountId: 'pa_1',
    accountId: 'mail_personal',
    messageId: '<a@weldmail.com>',
    threadId: 'msg_personal_1',
    from: { email: 'a@weldmail.com', name: 'Ada' },
    to: [{ email: 'b@weldmail.com' }],
    subject: 'Hello',
    preview: 'Hi there',
    sentDate: '2026-09-01T12:00:00.000Z',
    receivedDate: '2026-09-01T12:00:01.000Z',
    isRead: false,
    hasAttachments: false,
    ...overrides,
  };
}

describe('mail-tenant', () => {
  beforeEach(() => {
    rememberPersonalAccounts([]);
  });
  it('tracks personal account ids for later routing', () => {
    rememberPersonalAccounts(['mail_personal', 'mail_other']);
    expect(isPersonalAccountId('mail_personal')).toBe(true);
    expect(isPersonalAccountId('mail_workspace')).toBe(false);
  });

  it('normalizes a personal message onto the inbox row shape', () => {
    rememberPersonalAccounts(['mail_personal']);
    const row = normalizePersonalMessage(personalRow());
    expect(row.id).toBe('msg_personal_1');
    expect(row.accountId).toBe('mail_personal');
    expect(row.from?.email).toBe('a@weldmail.com');
    expect(row.hasAttachments).toBe(false);
    expect(isPersonalMessage(row.id, row.accountId)).toBe(true);
  });

  it('merges workspace + personal lists newest first and drops duplicate ids', () => {
    const a = [{ id: 'm1', sentDate: '2026-09-01T10:00:00.000Z', createdAt: '' }];
    const b = [
      { id: 'm2', sentDate: '2026-09-01T12:00:00.000Z', createdAt: '' },
      { id: 'm1', sentDate: '2026-09-01T10:00:00.000Z', createdAt: '' },
    ];
    const merged = mergeByDate(a, b);
    expect(merged.map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('treats tenantKind personal as a personal account', () => {
    expect(isPersonalAccount({ tenantKind: 'personal' })).toBe(true);
    expect(isPersonalAccount({ tenantKind: 'workspace' })).toBe(false);
    expect(isPersonalAccount(null)).toBe(false);
  });
});
