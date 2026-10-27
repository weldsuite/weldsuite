import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        messageItem: {
          viewProfile: 'View {name}',
          agentClickDetails: '(Agent)',
          agentThinking: 'Thinking',
          edited: '(edited)',
          reply: 'reply',
          replies: 'replies',
        },
        memberList: { agentBadge: 'Agent' },
      },
    },
    format: (text: string) => text,
  }),
}));
vi.mock('./chat-context', () => ({ useChatContext: () => ({ openUserProfile: vi.fn(), openAgentProfile: vi.fn() }) }));
vi.mock('./reaction-bar', () => ({ ReactionBar: () => null }));
vi.mock('./message-actions', () => ({ MessageActions: () => null }));
vi.mock('./message-context-menu', () => ({ MessageContextMenu: ({ children }: { children: unknown }) => children }));
vi.mock('./file-preview', () => ({ FilePreview: () => null }));
vi.mock('./entity-mention-chip', () => ({ EntityMentionChip: () => null }));
vi.mock('./message-approvals', () => ({
  MessageApprovals: ({ message }: { message: { metadata?: unknown } }) =>
    message.metadata ? <div data-testid="approvals-stub" /> : null,
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));

import { MessageItem, type MessageItemMessage } from './message-item';

const content = 'Here is the status:\n\n- **Done**: the report\n- Next: review\n\n1. First\n2. Second';

function message(overrides: Partial<MessageItemMessage>): MessageItemMessage {
  return {
    id: 'msg_1',
    type: 'message',
    content,
    authorId: 'agt_1',
    authorName: 'Task Researcher',
    authorType: 'agent',
    createdAt: '2026-10-27T10:00:00Z',
    ...overrides,
  } as MessageItemMessage;
}

describe('MessageItem markdown', () => {
  it('renders an agent message with real lists, bold and paragraphs instead of literal dashes', () => {
    render(<MessageItem message={message({})} />);
    const body = screen.getByTestId('chat-message-content');

    expect(body.querySelectorAll('ul > li')).toHaveLength(2);
    expect(body.querySelectorAll('ol > li')).toHaveLength(2);
    expect(body.querySelector('li strong')?.textContent).toBe('Done');
    expect(body.textContent).not.toContain('- ');
    expect(body.textContent).not.toContain('**');
    expect(body.querySelector('p')?.textContent).toBe('Here is the status:');
  });

  it('leaves a person\'s message as typed', () => {
    render(<MessageItem message={message({ authorType: 'user', authorId: 'user_2', authorName: 'Gert' })} />);
    const body = screen.getByTestId('chat-message-content');

    expect(body.querySelector('ul')).toBeNull();
    expect(body.textContent).toContain('- ');
  });

  it('renders a plain agent reply as plain text', () => {
    render(<MessageItem message={message({ content: 'All good, nothing to do.' })} />);
    const body = screen.getByTestId('chat-message-content');

    expect(body.textContent).toBe('All good, nothing to do.');
    expect(body.querySelector('p, ul, ol')).toBeNull();
  });

  it('shows the approval cards of an agent message that is waiting on someone', () => {
    render(<MessageItem message={message({ metadata: { approvals: [{ id: 'apr_1', label: 'x', status: 'pending' }] } })} />);
    expect(screen.getByTestId('approvals-stub')).toBeTruthy();
  });
});
