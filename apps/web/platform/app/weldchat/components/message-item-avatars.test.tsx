import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const avatar = vi.hoisted(() => ({ resolve: vi.fn() }));
const chat = vi.hoisted(() => ({ openThread: vi.fn() }));

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        messageItem: {
          viewProfile: 'View {name}',
          agentClickDetails: '(Agent)',
          edited: '(edited)',
          reply: 'reply',
          replies: 'replies',
          forwardedFrom: 'Forwarded from',
          aDirectMessage: 'a direct message',
          commentOn: 'Comment on {place}',
        },
        memberList: { agentBadge: 'Agent' },
      },
      weldboard: { editor: { comments: { onBoard: 'On the board' } } },
    },
    format: (text: string) => text,
  }),
}));
vi.mock('./chat-context', () => ({
  useChatContext: () => ({ openUserProfile: vi.fn(), openAgentProfile: vi.fn(), openThread: chat.openThread }),
}));
vi.mock('@/hooks/use-member-avatar', () => ({ useMemberAvatar: avatar.resolve }));
vi.mock('./reaction-bar', () => ({ ReactionBar: () => null }));
vi.mock('./message-actions', () => ({ MessageActions: () => null }));
vi.mock('./message-context-menu', () => ({ MessageContextMenu: ({ children }: { children: unknown }) => children }));
vi.mock('./file-preview', () => ({ FilePreview: () => null }));
vi.mock('./entity-mention-chip', () => ({ EntityMentionChip: () => null }));
vi.mock('./message-approvals', () => ({ MessageApprovals: () => null }));
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({ to, params, children, ...rest }: { to: string; params: Record<string, string>; children?: React.ReactNode }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? ''), ...rest }, children),
  };
});
vi.mock('@/lib/router', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => createElement('a', { href, ...rest }, children),
  };
});

import { MessageItem, type MessageItemMessage } from './message-item';

function message(overrides: Partial<MessageItemMessage> = {}): MessageItemMessage {
  return {
    id: 'msg_1',
    channelId: 'ch_1',
    type: 'message',
    content: 'Looks good',
    authorId: 'user_ada',
    authorName: 'Ada Lovelace',
    authorAvatar: 'https://cdn.test/avatars/ada_old.png',
    authorType: 'user',
    createdAt: '2026-11-20T10:00:00Z',
    ...overrides,
  } as MessageItemMessage;
}

beforeEach(() => {
  chat.openThread.mockReset();
  avatar.resolve.mockReset();
  avatar.resolve.mockReturnValue(undefined);
});

describe('MessageItem avatars', () => {
  it("looks up the author's current picture instead of the one stored on the message", () => {
    render(<MessageItem message={message()} />);
    expect(avatar.resolve).toHaveBeenCalledWith('user_ada', 'https://cdn.test/avatars/ada_old.png');
    expect(screen.getByTitle('View Ada Lovelace')).toHaveTextContent('A');
  });

  it("looks up a forwarded message's original author", () => {
    render(
      <MessageItem
        message={message({
          forwardedFrom: {
            messageId: 'msg_0',
            channelId: 'ch_0',
            channelName: 'general',
            channelType: 'public',
            authorId: 'user_grace',
            authorName: 'Grace Hopper',
            authorAvatar: 'https://cdn.test/avatars/grace_old.png',
            content: 'Ship it',
            createdAt: '2026-11-19T09:00:00Z',
          },
        })}
      />,
    );
    expect(avatar.resolve).toHaveBeenCalledWith('user_grace', 'https://cdn.test/avatars/grace_old.png');
    expect(screen.getByText('Forwarded from')).toBeInTheDocument();
  });

  it("looks up a quoted reply's author, but keeps an agent's emoji as is", () => {
    const { unmount } = render(
      <MessageItem
        message={message()}
        replyToMessage={{ authorId: 'user_grace', authorName: 'Grace Hopper', authorAvatar: null, content: 'Ship it?' }}
      />,
    );
    expect(avatar.resolve).toHaveBeenCalledWith('user_grace', null);
    unmount();

    avatar.resolve.mockClear();
    render(
      <MessageItem
        message={message()}
        replyToMessage={{ authorId: 'agt_1', authorName: 'Researcher', authorAvatar: '🔎', content: 'Found it' }}
      />,
    );
    expect(avatar.resolve).not.toHaveBeenCalledWith('agt_1', expect.anything());
    expect(screen.getByText('🔎')).toBeInTheDocument();
  });
});

describe('comment line', () => {
  const board = { type: 'board', title: 'Q4 plan' };
  const comment = (anchor: Record<string, string>) =>
    message({ content: 'Can we move this card?', metadata: { anchor: { id: 'pin_1', ...anchor } } });
  const line = () => screen.getByTestId('chat-message-comment-place').textContent;

  it('names the board by its title for a comment on the board itself', () => {
    render(<MessageItem message={comment({})} record={board} />);
    expect(line()).toBe('Comment on Q4 plan');
  });

  it("shows the title instead of the board's old placeholder", () => {
    render(<MessageItem message={comment({ label: 'On the board' })} record={board} />);
    expect(line()).toBe('Comment on Q4 plan');
  });

  it('names the element a comment is on', () => {
    render(<MessageItem message={comment({ label: 'Research box' })} record={board} />);
    expect(line()).toBe('Comment on Research box');
  });

  it('links to the board in WeldBoard', () => {
    render(<MessageItem message={comment({})} record={{ ...board, id: 'brd_1' }} />);
    expect(screen.getByRole('link', { name: 'Comment on Q4 plan' }).getAttribute('href')).toBe('/weldboard/brd_1');
  });

  it('is plain text while the record is unknown', () => {
    render(<MessageItem message={comment({})} record={board} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps a sheet cell as it is', () => {
    render(<MessageItem message={comment({ label: 'Sheet1!B7' })} record={{ type: 'sheet', title: 'Budget' }} />);
    expect(line()).toBe('Comment on Sheet1!B7');
  });
});

describe('thread replies', () => {
  const withReplies = message({ threadReplyCount: 2 });

  it('opens the thread in the side panel beside the channel', () => {
    render(<MessageItem message={withReplies} />);
    const indicator = screen.getByTestId('chat-thread-indicator');
    expect(indicator.tagName).toBe('BUTTON');
    expect(indicator.textContent).toBe('2 replies');
    fireEvent.click(indicator);
    expect(chat.openThread).toHaveBeenCalledWith('msg_1');
  });

  it("goes to the thread's page in a DM, which shows no side panel", () => {
    render(<MessageItem message={withReplies} isDm />);
    expect(screen.getByTestId('chat-thread-indicator').getAttribute('href')).toBe('/weldchat/ch_1/thread/msg_1');
    expect(chat.openThread).not.toHaveBeenCalled();
  });

  it("goes to the thread's page from a list across channels", () => {
    render(<MessageItem message={withReplies} showChannel />);
    expect(screen.getByTestId('chat-thread-indicator').getAttribute('href')).toBe('/weldchat/ch_1/thread/msg_1');
  });
});
