import { cachedMembership, conversationWebUrl, loadMembership } from '../conversation-menu';

const mockGet = jest.fn();

// Hoisted above the import by babel-jest.
jest.mock(
  '@/services/app-api',
  () => ({
    PLATFORM_URL: 'https://app-test.weldsuite.org',
    appApiClient: { get: (...args: unknown[]) => mockGet(...args) },
  }),
  { virtual: true },
);

describe('conversationWebUrl', () => {
  const origin = 'https://app.weldsuite.org';

  it('links a channel by its id', () => {
    expect(conversationWebUrl({ kind: 'channel', id: 'chn_1' }, origin)).toBe(
      'https://app.weldsuite.org/weldchat/chn_1',
    );
  });

  it('links a 1:1 conversation by the other person, like the web sidebar', () => {
    expect(conversationWebUrl({ kind: 'dm', id: 'chn_2', peerUserId: 'user_9' }, origin)).toBe(
      'https://app.weldsuite.org/weldchat/dm/user_9',
    );
  });

  it('links a group conversation by its id', () => {
    expect(conversationWebUrl({ kind: 'dm', id: 'chn_3', peerUserId: null }, origin)).toBe(
      'https://app.weldsuite.org/weldchat/dm/group/chn_3',
    );
  });

  it('defaults to the configured web app', () => {
    expect(conversationWebUrl({ kind: 'channel', id: 'chn_1' })).toBe('https://app-test.weldsuite.org/weldchat/chn_1');
  });
});

describe('membership cache', () => {
  it('keeps one person’s row from the next person to sign in', async () => {
    mockGet.mockImplementation((path: string) =>
      Promise.resolve({
        data: [
          path.includes('userId=user_a')
            ? { id: 'cm_a', isMuted: true, notificationPreference: 'none' }
            : { id: 'cm_b', isMuted: false, notificationPreference: 'all' },
        ],
      }),
    );

    await loadMembership('chn_1', 'user_a');
    expect(cachedMembership('chn_1', 'user_a')?.id).toBe('cm_a');
    expect(cachedMembership('chn_1', 'user_b')).toBeUndefined();
    expect(cachedMembership('chn_1', null)).toBeUndefined();

    const theirs = await loadMembership('chn_1', 'user_b');
    expect(theirs?.id).toBe('cm_b');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
