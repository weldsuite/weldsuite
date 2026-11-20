import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const avatar = vi.hoisted(() => ({ resolve: vi.fn() }));

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
        },
        memberList: { agentBadge: 'Agent' },
      },
    },
    format: (text: string) => text,
  }),
}));
vi.mock('./chat-context', () => ({ useChatContext: () => ({ openUserProfile: vi.fn(), openAgentProfile: vi.fn() }) }));
vi.mock('@/hooks/use-member-avatar', () => ({ useMemberAvatar: avatar.resolve }));
vi.mock('./reaction-bar', () => ({ ReactionBar: () => null }));
vi.mock('./message-actions', () => ({ MessageActions: () => null }));
vi.mock('./message-context-menu', () => ({ MessageContextMenu: ({ children }: { children: unknown }) => children }));
vi.mock('./file-preview', () => ({ FilePreview: () => null }));
vi.mock('./entity-mention-chip', () => ({ EntityMentionChip: () => null }));
vi.mock('./message-approvals', () => ({ MessageApprovals: () => null }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));

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
