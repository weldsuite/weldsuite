import {
  parseNotificationTarget,
  parseNotificationContent,
  emailOpenParams,
  stubEmailFromTarget,
  clipPreviewString,
  firstParam,
  nextNotificationListRetryMs,
  listContainsEmailId,
  notificationMatchesWorkspace,
} from '../notification-target';

describe('parseNotificationTarget', () => {
  it('reads both ids out of a new-email payload', () => {
    expect(
      parseNotificationTarget({
        type: 'new_email',
        emailId: 'msg_01HX3ABCDEF',
        emailAccountId: 'macc_01HX3ZYXWVU',
      }),
    ).toEqual({
      emailId: 'msg_01HX3ABCDEF',
      accountId: 'macc_01HX3ZYXWVU',
      clerkOrgId: undefined,
      fromName: undefined,
      fromEmail: undefined,
      subject: undefined,
      preview: undefined,
    });
  });

  it('keeps preview fields for instant chrome', () => {
    expect(
      parseNotificationTarget({
        emailId: 'msg_01HX3ABCDEF',
        emailAccountId: 'macc_01HX3ZYXWVU',
        fromName: 'Ada Lovelace',
        fromEmail: 'ada@example.com',
        subject: 'Notes',
        preview: 'See attached',
      }),
    ).toMatchObject({
      emailId: 'msg_01HX3ABCDEF',
      fromName: 'Ada Lovelace',
      fromEmail: 'ada@example.com',
      subject: 'Notes',
      preview: 'See attached',
    });
  });

  it('reads clerkOrgId when present', () => {
    expect(
      parseNotificationTarget({
        emailId: 'msg_01HX3ABCDEF',
        emailAccountId: 'macc_01HX3ZYXWVU',
        clerkOrgId: 'org_2NXz8Kabc123',
      }),
    ).toMatchObject({
      emailId: 'msg_01HX3ABCDEF',
      clerkOrgId: 'org_2NXz8Kabc123',
    });
  });

  it('drops a malformed clerkOrgId', () => {
    expect(
      parseNotificationTarget({
        emailId: 'msg_01HX3ABCDEF',
        clerkOrgId: 'not-an-org',
      }),
    ).toMatchObject({ clerkOrgId: undefined });
  });

  it('keeps the account id when the message id is missing', () => {
    // Falls back to "open the mailbox" rather than dropping the tap entirely.
    expect(parseNotificationTarget({ emailAccountId: 'macc_01HX3ZYXWVU' })).toEqual({
      emailId: undefined,
      accountId: 'macc_01HX3ZYXWVU',
      clerkOrgId: undefined,
      fromName: undefined,
      fromEmail: undefined,
      subject: undefined,
      preview: undefined,
    });
  });

  it('keeps the message id when the account id is missing', () => {
    expect(parseNotificationTarget({ emailId: 'msg_01HX3ABCDEF' })).toEqual({
      emailId: 'msg_01HX3ABCDEF',
      accountId: undefined,
      clerkOrgId: undefined,
      fromName: undefined,
      fromEmail: undefined,
      subject: undefined,
      preview: undefined,
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
    ).toEqual({
      emailId: undefined,
      accountId: 'macc_01HX3ZYXWVU',
      clerkOrgId: undefined,
      fromName: undefined,
      fromEmail: undefined,
      subject: undefined,
      preview: undefined,
    });

    expect(
      parseNotificationTarget({ emailId: 'msg_01HX3ABCDEF', emailAccountId: 'a/b' }),
    ).toEqual({
      emailId: 'msg_01HX3ABCDEF',
      accountId: undefined,
      clerkOrgId: undefined,
      fromName: undefined,
      fromEmail: undefined,
      subject: undefined,
      preview: undefined,
    });
  });

  it('ignores non-string ids', () => {
    expect(parseNotificationTarget({ emailId: 42, emailAccountId: { id: 'x' } })).toBeNull();
  });
});

describe('notificationMatchesWorkspace', () => {
  it('matches when clerkOrgId equals the active org', () => {
    expect(
      notificationMatchesWorkspace({ clerkOrgId: 'org_abc123' }, 'org_abc123'),
    ).toBe(true);
  });

  it('rejects a different active org', () => {
    expect(
      notificationMatchesWorkspace({ clerkOrgId: 'org_workspaceA' }, 'org_workspaceB'),
    ).toBe(false);
  });

  it('treats legacy payloads without clerkOrgId as matching', () => {
    expect(notificationMatchesWorkspace({}, 'org_abc123')).toBe(true);
    expect(notificationMatchesWorkspace({ clerkOrgId: undefined }, 'org_abc123')).toBe(true);
  });

  it('matches when the active org is not hydrated yet', () => {
    expect(notificationMatchesWorkspace({ clerkOrgId: 'org_abc123' }, null)).toBe(true);
    expect(notificationMatchesWorkspace({ clerkOrgId: 'org_abc123' }, undefined)).toBe(true);
  });
});

describe('parseNotificationContent', () => {
  it('fills fromName from the visible title when data omits it', () => {
    expect(
      parseNotificationContent({
        data: { emailId: 'msg_01HX3ABCDEF' },
        title: 'New email from Ada Lovelace',
        body: 'Quarterly notes',
      }),
    ).toMatchObject({
      emailId: 'msg_01HX3ABCDEF',
      fromName: 'Ada Lovelace',
      subject: 'Quarterly notes',
    });
  });

  it('prefers structured data over title/body', () => {
    expect(
      parseNotificationContent({
        data: { emailId: 'msg_01HX3ABCDEF', fromName: 'Grace', subject: 'Hello' },
        title: 'New email from Ada Lovelace',
        body: 'Quarterly notes',
      }),
    ).toMatchObject({ fromName: 'Grace', subject: 'Hello' });
  });
});

describe('emailOpenParams / stubEmailFromTarget', () => {
  it('builds route params for a message tap', () => {
    expect(
      emailOpenParams({
        emailId: 'msg_01HX3ABCDEF',
        fromName: 'Ada',
        subject: 'Hi',
        preview: 'Hello',
      }),
    ).toEqual({
      id: 'msg_01HX3ABCDEF',
      fromNotification: '1',
      fromName: 'Ada',
      subject: 'Hi',
      preview: 'Hello',
    });
  });

  it('returns null when there is no message id', () => {
    expect(emailOpenParams({ accountId: 'macc_01HX3ZYXWVU' })).toBeNull();
  });

  it('builds a chrome stub so the detail screen can paint before fetch', () => {
    const stub = stubEmailFromTarget('msg_01HX3ABCDEF', {
      fromName: 'Ada',
      fromEmail: 'ada@example.com',
      subject: 'Hi',
      preview: 'Hello',
    });
    expect(stub).toMatchObject({
      id: 'msg_01HX3ABCDEF',
      fromName: 'Ada',
      subject: 'Hi',
      preview: 'Hello',
      _fromNotification: true,
    });
  });

  it('returns null when there is nothing to paint', () => {
    expect(stubEmailFromTarget('msg_01HX3ABCDEF', {})).toBeNull();
  });
});

describe('clipPreviewString / firstParam', () => {
  it('strips control chars and caps length', () => {
    expect(clipPreviewString('  hello\nworld  ', 20)).toBe('hello world');
    expect(clipPreviewString('x'.repeat(200), 10)).toBe('x'.repeat(10));
    expect(clipPreviewString(12, 10)).toBeUndefined();
    expect(clipPreviewString('   ', 10)).toBeUndefined();
  });

  it('unwraps expo-router array params', () => {
    expect(firstParam('abc')).toBe('abc');
    expect(firstParam(['abc', 'def'])).toBe('abc');
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam('')).toBeUndefined();
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
