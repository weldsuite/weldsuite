import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        messageItem: { viewProfile: 'View {name}', edited: '(edited)', reply: 'reply', replies: 'replies' },
        memberList: { agentBadge: 'Agent' },
      },
      weldboard: { editor: { comments: { onBoard: 'On the board' } } },
    },
    format: (text: string) => text,
  }),
}));
vi.mock('./chat-context', () => ({
  useChatContext: () => ({ openUserProfile: vi.fn(), openAgentProfile: vi.fn(), openThread: vi.fn() }),
}));
vi.mock('@/hooks/use-member-avatar', () => ({ useMemberAvatar: () => undefined }));
vi.mock('./reaction-bar', () => ({ ReactionBar: () => null }));
// The hover bar, reduced to a menu that opens and closes (the emoji menu, the ⋯ menu).
vi.mock('./message-actions', () => ({
  MessageActions: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => (
    <div data-testid="message-actions">
      <button type="button" onClick={() => onOpenChange(true)}>Open menu</button>
      <button type="button" onClick={() => onOpenChange(false)}>Close menu</button>
    </div>
  ),
}));
vi.mock('./message-context-menu', () => ({ MessageContextMenu: ({ children }: { children: unknown }) => children }));
vi.mock('./file-preview', () => ({ FilePreview: () => null }));
vi.mock('./entity-mention-chip', () => ({ EntityMentionChip: () => null }));
vi.mock('./message-approvals', () => ({ MessageApprovals: () => null }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('@/lib/router', () => ({ Link: () => null }));

import { MessageItem, type MessageItemMessage } from './message-item';

const message: MessageItemMessage = {
  id: 'msg_1',
  channelId: 'ch_1',
  type: 'message',
  content: 'Looks good',
  authorId: 'user_gert',
  authorName: 'Gert',
  createdAt: '2026-11-21T10:00:00Z',
};

/** jsdom has no pointer, so `:hover` never matches; this says where the pointer is. */
function pointerOnRow(on: boolean) {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':hover' ? on && this.getAttribute('data-testid') === 'chat-message' : matches.call(this, selector);
  });
}

function hoverAndOpenMenu() {
  render(<MessageItem message={message} channelId="ch_1" />);
  fireEvent.mouseEnter(screen.getByTestId('chat-message'));
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the hover bar of a message', () => {
  it('stays when a menu closes with the pointer still on the message', () => {
    hoverAndOpenMenu();
    pointerOnRow(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.getByTestId('message-actions')).toBeInTheDocument();
  });

  it('goes when a menu closes with the pointer elsewhere', () => {
    hoverAndOpenMenu();
    // The pointer left the row for the menu, which hangs outside it.
    fireEvent.mouseLeave(screen.getByTestId('chat-message'));
    pointerOnRow(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByTestId('message-actions')).toBeNull();
  });
});
