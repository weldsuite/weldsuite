import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  mergeMessageIntoCache,
  resetThreadReplyCountTracking,
  useSendMessage,
  weldchatKeys,
  type ChatMessage,
} from './use-weldchat-queries';

const postMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({ post: (...args: unknown[]) => postMock(...args) }),
  }),
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: 'user_me' }),
  useUser: () => ({ user: { fullName: 'Me', firstName: 'Me', imageUrl: null } }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CHANNEL = 'ch_general';

type MessagesCache = InfiniteData<{ data?: { messages?: ChatMessage[] } }, string | undefined>;

function seedChannel(client: QueryClient, messages: ChatMessage[]) {
  const cache: MessagesCache = {
    pages: [{ data: { messages } }],
    pageParams: [undefined],
  };
  client.setQueryData(weldchatKeys.messages(CHANNEL), cache);
}

function channelMessages(client: QueryClient): ChatMessage[] {
  const cache = client.getQueryData<MessagesCache>(weldchatKeys.messages(CHANNEL));
  return cache?.pages.flatMap((p) => p.data?.messages ?? []) ?? [];
}

function parentOf(client: QueryClient, id: string): ChatMessage | undefined {
  return channelMessages(client).find((m) => m.id === id);
}

const parent: ChatMessage = {
  id: 'msg_parent',
  channelId: CHANNEL,
  content: 'Parent message',
  authorId: 'user_me',
  threadReplyCount: 0,
  createdAt: '2026-01-01T10:00:00.000Z',
};

const reply: ChatMessage = {
  id: 'msg_reply',
  channelId: CHANNEL,
  content: 'Thread reply test',
  authorId: 'user_me',
  parentId: 'msg_parent',
  createdAt: '2026-01-01T10:01:00.000Z',
};

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('mergeMessageIntoCache', () => {
  beforeEach(() => {
    resetThreadReplyCountTracking();
  });

  it('appends a top-level message to the channel timeline', () => {
    const client = newClient();
    seedChannel(client, [parent]);

    const next: ChatMessage = { id: 'msg_next', channelId: CHANNEL, content: 'Hello', createdAt: '2026-01-01T10:05:00.000Z' };
    mergeMessageIntoCache(client, CHANNEL, next);

    expect(channelMessages(client).map((m) => m.id)).toEqual(['msg_next', 'msg_parent']);
  });

  it('never inserts a thread reply into the channel timeline', () => {
    const client = newClient();
    seedChannel(client, [parent]);

    mergeMessageIntoCache(client, CHANNEL, reply);

    expect(channelMessages(client).map((m) => m.id)).toEqual(['msg_parent']);
  });

  it('bumps the parent reply count instead', () => {
    const client = newClient();
    seedChannel(client, [parent]);

    mergeMessageIntoCache(client, CHANNEL, reply);

    const updated = parentOf(client, 'msg_parent');
    expect(updated?.threadReplyCount).toBe(1);
    expect(updated?.threadLastReplyAt).toBe(reply.createdAt);
  });

  it('counts a reply once when it arrives both from the mutation and the realtime echo', () => {
    const client = newClient();
    seedChannel(client, [parent]);

    mergeMessageIntoCache(client, CHANNEL, reply);
    mergeMessageIntoCache(client, CHANNEL, { ...reply });

    expect(parentOf(client, 'msg_parent')?.threadReplyCount).toBe(1);
    expect(channelMessages(client)).toHaveLength(1);
  });

  it('counts distinct replies separately', () => {
    const client = newClient();
    seedChannel(client, [parent]);

    mergeMessageIntoCache(client, CHANNEL, reply);
    mergeMessageIntoCache(client, CHANNEL, { ...reply, id: 'msg_reply_2', content: 'Second' });

    expect(parentOf(client, 'msg_parent')?.threadReplyCount).toBe(2);
  });

  it('leaves the channel cache alone when the parent is not loaded', () => {
    const client = newClient();
    seedChannel(client, [{ id: 'msg_other', channelId: CHANNEL, content: 'Other' }]);

    mergeMessageIntoCache(client, CHANNEL, reply);

    expect(channelMessages(client).map((m) => m.id)).toEqual(['msg_other']);
  });

  it('adds the reply to a loaded thread cache and swaps out the optimistic row', () => {
    const client = newClient();
    seedChannel(client, [parent]);
    const threadKey = weldchatKeys.threadMessages(CHANNEL, 'msg_parent');
    client.setQueryData(threadKey, {
      data: [{ id: 'opt_1', content: reply.content, parentId: 'msg_parent', _optimistic: true }],
    });

    mergeMessageIntoCache(client, CHANNEL, reply);
    mergeMessageIntoCache(client, CHANNEL, { ...reply });

    const thread = client.getQueryData<{ data: ChatMessage[] }>(threadKey);
    expect(thread?.data.map((m) => m.id)).toEqual(['msg_reply']);
  });

  it('does not create a thread cache for a thread that was never loaded', () => {
    const client = newClient();
    seedChannel(client, [parent]);

    mergeMessageIntoCache(client, CHANNEL, reply);

    expect(client.getQueryData(weldchatKeys.threadMessages(CHANNEL, 'msg_parent'))).toBeUndefined();
  });
});

describe('useSendMessage', () => {
  beforeEach(() => {
    resetThreadReplyCountTracking();
    postMock.mockReset();
  });

  function wrapperFor(client: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };
  }

  it('keeps an optimistic thread reply out of the channel timeline and leaves the reply count at one', async () => {
    const client = newClient();
    seedChannel(client, [parent]);
    const threadKey = weldchatKeys.threadMessages(CHANNEL, 'msg_parent');
    client.setQueryData(threadKey, { data: [] });

    let resolvePost: (value: { data: ChatMessage }) => void = () => {};
    postMock.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));

    const { result } = renderHook(() => useSendMessage(), { wrapper: wrapperFor(client) });

    act(() => {
      result.current.mutate({
        channelId: CHANNEL,
        content: reply.content ?? '',
        parentId: 'msg_parent',
        _optimisticId: 'opt_1',
      });
    });

    // Optimistic phase: shown in the thread, absent from the channel.
    await waitFor(() => {
      const thread = client.getQueryData<{ data: ChatMessage[] }>(threadKey);
      expect(thread?.data.map((m) => m.id)).toEqual(['opt_1']);
    });
    expect(channelMessages(client).map((m) => m.id)).toEqual(['msg_parent']);

    // Server confirms, then the realtime echo of the same reply arrives too.
    await act(async () => {
      resolvePost({ data: reply });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    mergeMessageIntoCache(client, CHANNEL, { ...reply });

    expect(channelMessages(client).map((m) => m.id)).toEqual(['msg_parent']);
    expect(parentOf(client, 'msg_parent')?.threadReplyCount).toBe(1);
  });

  it('still adds a top-level message optimistically to the channel timeline', async () => {
    const client = newClient();
    seedChannel(client, [parent]);
    postMock.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useSendMessage(), { wrapper: wrapperFor(client) });

    act(() => {
      result.current.mutate({ channelId: CHANNEL, content: 'Top level', _optimisticId: 'opt_top' });
    });

    await waitFor(() => {
      expect(channelMessages(client).map((m) => m.id)).toEqual(['opt_top', 'msg_parent']);
    });
  });
});
