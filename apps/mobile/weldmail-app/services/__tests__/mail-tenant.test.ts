import {
  mergeByDate,
  normalizePersonalMessage,
  rememberPersonalAccounts,
  isPersonalAccountId,
  isPersonalMessage,
  isPersonalAccount,
  isLinkOnlySubscription,
  mergeInboxSources,
} from '../mail-tenant';
import type { MailMessage } from '@weldsuite/personal-api-client';
import type { EmailListItem } from '@/types/mail';

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

describe('isLinkOnlySubscription', () => {
  it('is true only for a plain https link without one-click or mailto', () => {
    expect(isLinkOnlySubscription({ unsubscribeUrl: 'https://x.com/u', unsubscribeMailto: null, oneClick: false })).toBe(true);
    expect(isLinkOnlySubscription({ unsubscribeUrl: 'https://x.com/u', unsubscribeMailto: null, oneClick: true })).toBe(false);
    expect(isLinkOnlySubscription({ unsubscribeUrl: 'https://x.com/u', unsubscribeMailto: 'mailto:u@x.com', oneClick: false })).toBe(false);
    expect(isLinkOnlySubscription({ unsubscribeUrl: null, unsubscribeMailto: 'mailto:u@x.com', oneClick: false })).toBe(false);
  });
});

describe('mergeInboxSources', () => {
  const row = (id: string, sentDate: string) =>
    ({ id, sentDate, createdAt: sentDate }) as unknown as EmailListItem;
  const src = (rows: EmailListItem[], hasMore: boolean, cursor?: string) => ({
    page: { rows, hasMore, cursor: hasMore ? rows[rows.length - 1]!.id : null },
    cursor,
    done: false,
  });

  it('shows the newest rows and resumes each source after its last shown row', () => {
    const ws = [row('w1', '2026-09-05'), row('w2', '2026-09-03'), row('w3', '2026-09-01')];
    const ps = [row('p1', '2026-09-04'), row('p2', '2026-09-02'), row('p3', '2026-08-30')];
    const page = mergeInboxSources(3, src(ws, true), src(ps, true));
    expect(page.items.map((m) => m.id)).toEqual(['w1', 'p1', 'w2']);
    // p2 and w3 were fetched but not shown, so both are re-read next time.
    expect(page.cursor).toEqual({
      workspace: 'w2',
      personal: 'p1',
      workspaceDone: false,
      personalDone: false,
    });
  });

  it('keeps a source cursor unchanged when none of its rows were shown', () => {
    const ws = [row('w1', '2026-09-05'), row('w2', '2026-09-04')];
    const ps = [row('p1', '2026-08-01')];
    const page = mergeInboxSources(2, src(ws, true), src(ps, false, 'p0'));
    expect(page.items.map((m) => m.id)).toEqual(['w1', 'w2']);
    expect(page.cursor).toMatchObject({ workspace: 'w2', personal: 'p0', personalDone: false });
  });

  it('returns a null cursor once both sources are exhausted', () => {
    const page = mergeInboxSources(
      10,
      src([row('w1', '2026-09-05')], false),
      src([row('p1', '2026-09-04')], false),
    );
    expect(page.items.map((m) => m.id)).toEqual(['w1', 'p1']);
    expect(page.cursor).toBeNull();
  });

  it('skips a source that is already done', () => {
    const page = mergeInboxSources(
      2,
      { page: null, cursor: 'w9', done: true },
      src([row('p1', '2026-09-04'), row('p2', '2026-09-03')], true),
    );
    expect(page.items.map((m) => m.id)).toEqual(['p1', 'p2']);
    expect(page.cursor).toMatchObject({ workspaceDone: true, personal: 'p2', personalDone: false });
  });
});
