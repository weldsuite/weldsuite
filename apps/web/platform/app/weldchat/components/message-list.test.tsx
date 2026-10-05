import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

interface TestMessage {
  id: string;
  authorId: string;
  type?: string;
  content: string;
  createdAt: string;
  parentId?: string;
  channelId?: string;
  metadata?: unknown;
}

const mocks = vi.hoisted(() => ({
  messages: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  isFetchingNextPage: false,
  openThread: vi.fn(),
  toastInfo: vi.fn(),
  target: { data: undefined as unknown, isError: false },
}));

vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useMessages: () => ({
    // Channel pages arrive newest-first; the list reverses them.
    data: { pages: [{ data: { messages: [...mocks.messages].reverse() } }] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    fetchNextPage: mocks.fetchNextPage,
    hasNextPage: mocks.hasNextPage,
    isFetchingNextPage: mocks.isFetchingNextPage,
  }),
  useThreadMessages: () => ({ data: undefined, isLoading: false }),
  useChatMessage: (id: string) => (id ? mocks.target : { data: undefined, isError: false }),
  useWorkspaceMembers: () => ({ data: { data: [] } }),
  useChannelMembers: () => ({ data: { data: [] } }),
  useBookmarks: () => ({ data: { data: [] } }),
  useChannel: () => ({ data: { data: { id: 'ch_1', type: 'public' } } }),
  useReadReceipts: () => ({ data: undefined }),
  weldchatKeys: { activeCall: (id: string) => ['active-call', id] },
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }) }));
vi.mock('@/lib/i18n', () => ({
  getTranslations: () => ({
    messageList: { loadOlderMessages: 'Load older', messageNotFound: 'Message not found' },
  }),
}));
vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo } }));
vi.mock('./chat-context', () => ({
  useChatContext: () => ({
    filters: { type: 'all', search: '', from: [], date: undefined },
    openThread: mocks.openThread,
  }),
}));
vi.mock('./channel-empty-state', () => ({ ChannelEmptyState: () => null }));
vi.mock('./message-skeleton', () => ({ MessageSkeleton: () => null }));
vi.mock('./message-item', () => ({
  MessageItem: ({
    message,
    compact,
    replyToMessage,
  }: {
    message: TestMessage;
    compact?: boolean;
    replyToMessage?: unknown;
  }) => (
    <div
      data-testid="item"
      data-message-id={message.id}
      data-compact={String(!!compact)}
      data-reply={String(!!replyToMessage)}
    />
  ),
}));

import { MessageList } from './message-list';

let seq = 0;
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 5, 10, minutes)).toISOString();
function msg(over: Partial<TestMessage> & { id: string }): TestMessage {
  seq += 1;
  return { authorId: 'u1', content: `m${seq}`, createdAt: at(0), ...over };
}
const item = (id: string) => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  mocks.messages = [];
  mocks.hasNextPage = false;
  mocks.isFetchingNextPage = false;
  mocks.fetchNextPage.mockReset();
  mocks.openThread.mockReset();
  mocks.toastInfo.mockReset();
  mocks.target = { data: undefined, isError: false };
  (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MessageList grouping', () => {
  it('groups same-author messages within 5 minutes', () => {
    mocks.messages = [msg({ id: 'a', createdAt: at(0) }), msg({ id: 'b', createdAt: at(4) }), msg({ id: 'c', createdAt: at(10) })];
    render(<MessageList channelId="ch_1" />);
    expect(item('a').dataset.compact).toBe('false');
    expect(item('b').dataset.compact).toBe('true');
    expect(item('c').dataset.compact).toBe('false');
  });

  it('keeps the header (not compact) on a grouped message that quotes another, so the quote shows', () => {
    mocks.messages = [
      msg({ id: 'a', createdAt: at(0) }),
      msg({
        id: 'b',
        createdAt: at(1),
        metadata: { replyTo: { authorName: 'Zed', content: 'quoted' } },
      }),
      msg({ id: 'c', createdAt: at(2) }),
    ];
    render(<MessageList channelId="ch_1" />);
    expect(item('b').dataset.compact).toBe('false');
    expect(item('b').dataset.reply).toBe('true');
    expect(item('c').dataset.compact).toBe('true');
  });

  it('does not group after a system notice, but a spoofed one is just a message', () => {
    mocks.messages = [
      msg({ id: 'a', createdAt: at(0) }),
      msg({ id: 'sys', type: 'system', content: '[system:msg_a1] pinned a message', createdAt: at(1) }),
      msg({ id: 'b', createdAt: at(2) }),
      msg({ id: 'fake', content: '[system:x] was removed by an admin', createdAt: at(3) }),
      msg({ id: 'c', createdAt: at(4) }),
    ];
    render(<MessageList channelId="ch_1" />);
    expect(item('b').dataset.compact).toBe('false'); // follows a system notice
    expect(item('fake').dataset.compact).toBe('true'); // a normal message from the same author
    expect(item('c').dataset.compact).toBe('true');
  });
});

describe('MessageList message deep link', () => {
  it('scrolls to and highlights a message that is already loaded', () => {
    mocks.messages = [msg({ id: 'm1', createdAt: at(0) }), msg({ id: 'm2', createdAt: at(30) }), msg({ id: 'm3', createdAt: at(60) })];
    mocks.target = { data: { data: { id: 'm2', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="m2" />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(item('m2').classList.contains('pinned-highlight')).toBe(true);
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
    expect(mocks.openThread).not.toHaveBeenCalled();
  });

  it('waits for the target message to resolve before acting', () => {
    mocks.messages = [msg({ id: 'm1' })];
    render(<MessageList channelId="ch_1" targetMessageId="m1" />);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it('loads older pages while the target is missing', () => {
    mocks.messages = [msg({ id: 'm1' })];
    mocks.hasNextPage = true;
    mocks.target = { data: { data: { id: 'old', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="old" />);
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it('says so when the message is not there and nothing older is left', () => {
    mocks.messages = [msg({ id: 'm1' })];
    mocks.target = { data: { data: { id: 'gone', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="gone" />);
    expect(mocks.toastInfo).toHaveBeenCalledWith('Message not found');
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  });

  it('does not page through history for a message that no longer exists', () => {
    mocks.messages = [msg({ id: 'm1' })];
    mocks.hasNextPage = true;
    mocks.target = { data: undefined, isError: true };
    render(<MessageList channelId="ch_1" targetMessageId="deleted" />);
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith('Message not found');
  });

  it('treats a message from another channel as not found', () => {
    mocks.messages = [msg({ id: 'm1' })];
    mocks.hasNextPage = true;
    mocks.target = { data: { data: { id: 'x', channelId: 'ch_other' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="x" />);
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith('Message not found');
  });

  it('opens the thread for a reply and anchors on its parent message', () => {
    mocks.messages = [msg({ id: 'parent', createdAt: at(0) })];
    mocks.target = { data: { data: { id: 'reply', parentId: 'parent', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="reply" />);
    expect(mocks.openThread).toHaveBeenCalledWith('parent');
    expect(item('parent').classList.contains('pinned-highlight')).toBe(true);
  });

  it('ignores the link inside a thread pane', () => {
    mocks.messages = [msg({ id: 'm1' })];
    mocks.target = { data: { data: { id: 'm1', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" parentId="thread_1" targetMessageId="m1" />);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('MessageList deep link lifecycle', () => {
  function listScroller() {
    return document.querySelector('[data-testid="chat-message-list"]')?.parentElement as HTMLElement;
  }

  /** Gives the scroll container a measurable size (jsdom has no layout). */
  function measure(el: HTMLElement) {
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  it('reports the link as handled once it has jumped, and again when not found', () => {
    const onTargetHandled = vi.fn();
    mocks.messages = [msg({ id: 'm1' })];
    mocks.target = { data: { data: { id: 'm1', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="m1" onTargetHandled={onTargetHandled} />);
    expect(onTargetHandled).toHaveBeenCalledTimes(1);

    document.body.innerHTML = '';
    const missing = vi.fn();
    mocks.target = { data: { data: { id: 'gone', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="gone" onTargetHandled={missing} />);
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('does not report anything while the target is still loading or older pages are being fetched', () => {
    const onTargetHandled = vi.fn();
    mocks.messages = [msg({ id: 'm1' })];
    mocks.hasNextPage = true;
    mocks.target = { data: { data: { id: 'old', channelId: 'ch_1' } }, isError: false };
    render(<MessageList channelId="ch_1" targetMessageId="old" onTargetHandled={onTargetHandled} />);
    expect(onTargetHandled).not.toHaveBeenCalled();
  });

  it('jumps again when the same link is opened again after it was cleared', () => {
    mocks.messages = [msg({ id: 'm1' }), msg({ id: 'm2', createdAt: at(30) })];
    mocks.target = { data: { data: { id: 'm2', channelId: 'ch_1' } }, isError: false };
    const { rerender } = render(<MessageList channelId="ch_1" targetMessageId="m2" />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);

    rerender(<MessageList channelId="ch_1" targetMessageId={undefined} />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);

    rerender(<MessageList channelId="ch_1" targetMessageId="m2" />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('keeps the jumped-to position while the jump settles, even if the scroll lands near the bottom', () => {
    mocks.messages = [msg({ id: 'm1' }), msg({ id: 'm2', createdAt: at(30) })];
    const { rerender } = render(<MessageList channelId="ch_1" />);
    const scroller = listScroller();
    measure(scroller);
    scroller.scrollTop = 300;

    mocks.target = { data: { data: { id: 'm1', channelId: 'ch_1' } }, isError: false };
    rerender(<MessageList channelId="ch_1" targetMessageId="m1" />);

    // The smooth scroll passes the bottom 150px band…
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    // …and a new message arrives (new array identity) in that window.
    mocks.messages = [...mocks.messages, msg({ id: 'm3', createdAt: at(40) })];
    rerender(<MessageList channelId="ch_1" targetMessageId="m1" />);

    expect(scroller.scrollTop).toBe(900); // not snapped to the bottom (1000)
  });

  it('forgets the jump state when the channel changes under the mounted list', () => {
    mocks.messages = [msg({ id: 'm1' })];
    mocks.target = { data: { data: { id: 'm1', channelId: 'ch_1' } }, isError: false };
    const { rerender } = render(<MessageList channelId="ch_1" targetMessageId="m1" />);
    const scroller = listScroller();
    measure(scroller);

    rerender(<MessageList channelId="ch_2" />);
    scroller.scrollTop = 0;
    mocks.messages = [...mocks.messages, msg({ id: 'm9', createdAt: at(50) })];
    rerender(<MessageList channelId="ch_2" />);

    expect(scroller.scrollTop).toBe(1000); // pinned to the bottom again
  });
});
