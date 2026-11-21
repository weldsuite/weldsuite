import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const postMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ post: postMock }) }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ userId: 'user_ada' }),
  useUser: () => ({ user: { fullName: 'Ada Lovelace', imageUrl: 'https://img.provider.test/ada.png' } }),
}));
vi.mock('@/hooks/use-member-avatar', () => ({ useCurrentUserAvatar: () => 'https://cdn.test/avatars/ada_2.png' }));

import { meetingChatKeys, useSendMeetingMessage } from './use-meeting-chat-queries';

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

describe('useSendMeetingMessage', () => {
  it("shows the sender's profile picture on the message while it sends", async () => {
    queryClient.setQueryData(meetingChatKeys.messages('mtg_1'), {
      pages: [{ data: { messages: [], hasMore: false } }],
      pageParams: [undefined],
    });
    let release: (value: unknown) => void = () => {};
    postMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useSendMeetingMessage(), { wrapper });

    act(() => {
      result.current.mutate({ meetingId: 'mtg_1', content: 'Hello', _optimisticId: 'opt_1' });
    });

    await vi.waitFor(() => {
      const cache = queryClient.getQueryData<{ pages: Array<{ data: { messages: Array<Record<string, unknown>> } }> }>(
        meetingChatKeys.messages('mtg_1'),
      );
      expect(cache?.pages[0]?.data.messages[0]).toMatchObject({
        id: 'opt_1',
        authorId: 'user_ada',
        authorName: 'Ada Lovelace',
        authorAvatar: 'https://cdn.test/avatars/ada_2.png',
        _optimistic: true,
      });
    });
    release({ data: { id: 'msg_1' } });
  });
});
