import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { encodeVisualMarker, type ChatVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns], getLocale: () => 'en' };
});
// The composer is the chat's own; here it is a button that sends a fixed prompt.
vi.mock('@/components/weldagent/agent-chat-input', () => ({
  AgentChatInput: ({ onSubmit, placeholder }: { onSubmit: (text: string) => void; placeholder?: string }) => (
    <button type="button" onClick={() => onSubmit('Chart my tickets')}>
      {placeholder}
    </button>
  ),
}));
vi.mock('@/components/weldagent/chat/chat-message', () => ({
  AssistantMessage: ({ content }: { content: string }) => <div data-testid="reply">{content.length}</div>,
  TypingIndicator: ({ label }: { label?: string }) => <div>{label}</div>,
  UserMessage: ({ children }: { children: string }) => <div>{children}</div>,
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-agent-queries', () => ({
  useAgents: () => ({ data: [{ id: 'agt_1', name: 'Sales agent' }] }),
}));
const chat = vi.hoisted(() => ({
  state: {
    messages: [] as Array<{ id: string; role: 'user' | 'assistant'; content: string }>,
    isSending: false,
    error: null as 'credits' | 'generic' | null,
  },
  sendMessage: vi.fn(),
  reset: vi.fn(),
  lastAgentId: undefined as string | null | undefined,
}));
vi.mock('@/hooks/queries/use-ai-chat', () => ({
  useWeldAgentChat: ({ agentId }: { agentId?: string | null }) => {
    chat.lastAgentId = agentId;
    return { ...chat.state, sendMessage: chat.sendMessage, reset: chat.reset };
  },
}));

import { TryWithAi } from './try-with-ai';

const visual: ChatVisual = {
  type: 'chart',
  kind: 'bar',
  title: 'Tickets per status',
  labels: ['Open', 'Solved'],
  series: [{ name: 'Tickets', values: [3, 9] }],
};

beforeEach(() => {
  chat.state = { messages: [], isSending: false, error: null };
  chat.sendMessage.mockClear();
  toast.success.mockClear();
});

describe('TryWithAi', () => {
  it('asks WeldAgent by default', () => {
    render(<TryWithAi onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chart my open tickets per status' }));
    expect(chat.sendMessage).toHaveBeenCalledWith('Chart my tickets');
    expect(chat.lastAgentId).toBeNull();
  });

  it('shows the reply and the spec of each visual it showed, to copy or open in the editor', async () => {
    chat.state.messages = [
      { id: 'u1', role: 'user', content: 'Chart my tickets' },
      { id: 'a1', role: 'assistant', content: `Here.${encodeVisualMarker(visual)}` },
    ];
    const onOpen = vi.fn();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TryWithAi onOpen={onOpen} />);

    expect(screen.getByText('Chart my tickets')).toBeTruthy();
    expect(screen.getByTestId('reply')).toBeTruthy();
    expect(screen.getByText('Tickets per status')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(onOpen).toHaveBeenCalledWith(visual);
    fireEvent.click(screen.getByRole('button', { name: 'Copy spec' }));
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Spec copied'));
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(visual);
  });

  it('says when the reply showed no visuals', () => {
    chat.state.messages = [{ id: 'a1', role: 'assistant', content: 'Just text.' }];
    render(<TryWithAi onOpen={vi.fn()} />);
    expect(screen.getByText('The reply showed no visuals.')).toBeTruthy();
  });

  it('shows that it is working, and why a reply failed', () => {
    chat.state.isSending = true;
    const { rerender } = render(<TryWithAi onOpen={vi.fn()} />);
    expect(screen.getByText('Working…')).toBeTruthy();
    // A second send while one runs is ignored.
    fireEvent.click(screen.getByRole('button', { name: 'Chart my open tickets per status' }));
    expect(chat.sendMessage).not.toHaveBeenCalled();

    chat.state = { messages: [], isSending: false, error: 'credits' };
    rerender(<TryWithAi onOpen={vi.fn()} />);
    expect(screen.getByText("You're out of AI credits. Top up your workspace to keep chatting.")).toBeTruthy();
    chat.state.error = 'generic';
    rerender(<TryWithAi onOpen={vi.fn()} />);
    expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
  });
});
