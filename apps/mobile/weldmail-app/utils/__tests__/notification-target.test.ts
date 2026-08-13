import {
  parseNotificationTarget,
  nextNotificationListRetryMs,
  listContainsEmailId,
} from '../notification-target';

describe('parseNotificationTarget', () => {
  it('reads both ids out of a new-email payload', () => {
    expect(
      parseNotificationTarget({
        type: 'new_email',
        emailId: 'msg_01HX3ABCDEF',
        emailAccountId: 'macc_01HX3ZYXWVU',
      }),
    ).toEqual({ emailId: 'msg_01HX3ABCDEF', accountId: 'macc_01HX3ZYXWVU' });
  });

  it('keeps the account id when the message id is missing', () => {
    // Falls back to "open the mailbox" rather than dropping the tap entirely.
    expect(parseNotificationTarget({ emailAccountId: 'macc_01HX3ZYXWVU' })).toEqual({
      emailId: undefined,
      accountId: 'macc_01HX3ZYXWVU',
    });
  });

  it('keeps the message id when the account id is missing', () => {
    expect(parseNotificationTarget({ emailId: 'msg_01HX3ABCDEF' })).toEqual({
      emailId: 'msg_01HX3ABCDEF',
      accountId: undefined,
    });
  });

  it('returns null when there is nothing to act on', () => {
    expect(parseNotificationTarget({ type: 'new_email' })).toBeNull();
    expect(parseNotificationTarget({})).toBeNull();
    expect(parseNotificationTarget(undefined)).toBeNull();
    expect(parseNotificationTarget(null)).toBeNull();
    expect(parseNotificationTarget('msg_01HX3ABCDEF')).toBeNull();
  });

  it('drops ids that do not match the generateId() shape', () => {
    // Path-injection guard: the payload arrives via Expo and is untrusted.
    expect(parseNotificationTarget({ emailId: '../../settings' })).toBeNull();
    expect(parseNotificationTarget({ emailId: 'msg 01', emailAccountId: 'a/b' })).toBeNull();
    expect(parseNotificationTarget({ emailId: 'x'.repeat(41) })).toBeNull();
    expect(parseNotificationTarget({ emailId: '' })).toBeNull();
  });

  it('drops only the malformed half of a mixed payload', () => {
    expect(
      parseNotificationTarget({ emailId: '../../settings', emailAccountId: 'macc_01HX3ZYXWVU' }),
    ).toEqual({ emailId: undefined, accountId: 'macc_01HX3ZYXWVU' });

    expect(
      parseNotificationTarget({ emailId: 'msg_01HX3ABCDEF', emailAccountId: 'a/b' }),
    ).toEqual({ emailId: 'msg_01HX3ABCDEF', accountId: undefined });
  });

  it('ignores non-string ids', () => {
    expect(parseNotificationTarget({ emailId: 42, emailAccountId: { id: 'x' } })).toBeNull();
  });
});

describe('notification inbox retry helpers', () => {
  it('returns increasing delays then null once retries are exhausted', () => {
    expect(nextNotificationListRetryMs(0)).toBe(400);
    expect(nextNotificationListRetryMs(1)).toBe(1000);
    expect(nextNotificationListRetryMs(2)).toBe(2000);
    expect(nextNotificationListRetryMs(3)).toBeNull();
    expect(nextNotificationListRetryMs(-1)).toBeNull();
  });

  it('detects whether a list page already contains the notified email', () => {
    const rows = [{ id: 'msg_01AAA' }, { id: 'msg_01BBB' }];
    expect(listContainsEmailId(rows, 'msg_01BBB')).toBe(true);
    expect(listContainsEmailId(rows, 'msg_01CCC')).toBe(false);
    expect(listContainsEmailId([], 'msg_01AAA')).toBe(false);
  });
});
