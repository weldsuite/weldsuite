import {
  EMAIL_READ_PUSH_TYPE,
  badgeFromCounts,
  bannerIsStale,
  findMailReadPush,
  findNewEmailCount,
  parseCount,
  parseMailReadPush,
  presentedEmailId,
} from '../mail-read-push';

const readData = {
  type: EMAIL_READ_PUSH_TYPE,
  emailIds: 'mmsg_01HX3ABCDEF,mmsg_01HX3ZYXWVU',
  tenantKind: 'workspace',
  inboxUnread: '4',
};

describe('parseMailReadPush', () => {
  it('reads the ids, tenancy and count', () => {
    expect(parseMailReadPush(readData)).toEqual({
      emailIds: ['mmsg_01HX3ABCDEF', 'mmsg_01HX3ZYXWVU'],
      tenantKind: 'workspace',
      inboxUnread: 4,
    });
  });

  it('drops ids that are not ours and ignores other push types', () => {
    expect(parseMailReadPush({ ...readData, emailIds: '../etc,mmsg_ok, ,mmsg_ok' })?.emailIds).toEqual(['mmsg_ok']);
    expect(parseMailReadPush({ ...readData, emailIds: '../etc' })).toBeNull();
    expect(parseMailReadPush({ type: 'new_email', emailId: 'mmsg_1' })).toBeNull();
    expect(parseMailReadPush(null)).toBeNull();
  });

  it('treats an unknown tenancy as workspace and a bad count as unknown', () => {
    expect(parseMailReadPush({ ...readData, tenantKind: 'x', inboxUnread: '-1' })).toMatchObject({
      tenantKind: 'workspace',
      inboxUnread: undefined,
    });
  });
});

describe('findMailReadPush', () => {
  it('finds the data wherever Expo put it', () => {
    const expected = expect.objectContaining({ emailIds: ['mmsg_01HX3ABCDEF', 'mmsg_01HX3ZYXWVU'] });
    expect(findMailReadPush({ notification: null, data: readData })).toEqual(expected);
    expect(findMailReadPush({ notification: null, data: { dataString: JSON.stringify(readData) } })).toEqual(expected);
    expect(findMailReadPush({ notification: null, data: { body: JSON.stringify(readData) } })).toEqual(expected);
    expect(findMailReadPush({ notification: null, data: { body: readData } })).toEqual(expected);
  });

  it('ignores taps and junk', () => {
    expect(findMailReadPush({ actionIdentifier: 'default', notification: {}, data: readData })).toBeNull();
    expect(findMailReadPush({ data: { dataString: '{not json' } })).toBeNull();
    expect(findMailReadPush(undefined)).toBeNull();
  });
});

describe('findNewEmailCount', () => {
  it('reads the tenancy count off a new-email push', () => {
    expect(
      findNewEmailCount({ data: { type: 'new_email', emailId: 'mmsg_1', tenantKind: 'personal', inboxUnread: '7' } }),
    ).toEqual({ tenantKind: 'personal', inboxUnread: 7 });
    expect(findNewEmailCount({ data: { type: 'new_email', emailId: 'mmsg_1' } })).toBeNull();
    expect(findNewEmailCount({ data: readData })).toBeNull();
  });
});

describe('presentedEmailId', () => {
  it('returns the email of a new-email banner only', () => {
    expect(presentedEmailId({ type: 'new_email', emailId: 'mmsg_1' })).toBe('mmsg_1');
    expect(presentedEmailId({ emailId: 'bad id!' })).toBeUndefined();
    expect(presentedEmailId(readData)).toBeUndefined();
  });
});

describe('bannerIsStale', () => {
  it('is stale once the email is read, trashed, spammed or out of the inbox', () => {
    expect(bannerIsStale({ isRead: true, labels: ['INBOX'] })).toBe(true);
    expect(bannerIsStale({ isTrash: true })).toBe(true);
    expect(bannerIsStale({ isSpam: true })).toBe(true);
    expect(bannerIsStale({ isRead: false, labels: ['ARCHIVE'] })).toBe(true);
  });

  it('stays while the email is unread in the inbox, including legacy rows without labels', () => {
    expect(bannerIsStale({ isRead: false, labels: ['INBOX', 'IMPORTANT'] })).toBe(false);
    expect(bannerIsStale({ isRead: false, labels: null })).toBe(false);
  });
});

describe('badge counts', () => {
  it('sums both tenancies, a missing one counting as zero', () => {
    expect(badgeFromCounts({ workspace: 3, personal: 2 })).toBe(5);
    expect(badgeFromCounts({ personal: 2 })).toBe(2);
    expect(badgeFromCounts({})).toBe(0);
  });

  it('parses counts from strings and numbers only', () => {
    expect(parseCount('12')).toBe(12);
    expect(parseCount(0)).toBe(0);
    expect(parseCount('1.5')).toBeUndefined();
    expect(parseCount('')).toBeUndefined();
    expect(parseCount(undefined)).toBeUndefined();
  });
});
