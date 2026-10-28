import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { WeldAgentMessage } from '@/hooks/queries/use-weldagent-queries';

const state = vi.hoisted(() => ({
  search: {} as { prompt?: string; conversation?: string },
  history: undefined as unknown[] | undefined,
  historyArg: undefined as string | null | undefined,
  createConversation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useSearch: () => state.search }),
  useNavigate: () => state.navigate,
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'token' }),
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

vi.mock('@/components/breadcrumb-header', () => ({ BreadcrumbHeader: () => null }));
vi.mock('@/components/layout/module-content', () => ({
  ModuleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// The composer's @ picker searches records; nothing is tagged here.
vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: () => ({ data: undefined, isFetching: false }),
}));

vi.mock('@/hooks/queries/use-weldagent-queries', () => ({
  useCreateConversation: () => ({ mutateAsync: state.createConversation }),
  useSaveMessage: () => ({ mutateAsync: async () => ({}) }),
  useWeldAgentConversationMessages: (id: string | null) => {
    state.historyArg = id;
    const data = id ? state.history : undefined;
    return { data, isPending: data === undefined };
  },
}));

import ChatPage from './new-chat-page';

const tChat = en.common.ai.chat;

function row(id: string, role: 'user' | 'assistant', content: string) {
  return { id, role, content } as unknown as WeldAgentMessage;
}

/** Answers the next `/api/ai/chat/stream` call with a body the test writes to. */
function streamNextReply() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 200 }));
  return {
    write: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => controller.close(),
  };
}

beforeEach(() => {
  state.search = {};
  state.history = undefined;
  state.historyArg = undefined;
  state.createConversation.mockReset();
  state.navigate.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

describe('new chat page', () => {
  it('uses the WeldAgent composer, like the home page', () => {
    render(<ChatPage />);

    const composer = screen.getByPlaceholderText(tChat.placeholder);
    // Same component, under the same view-transition name as the home page's.
    expect(composer.closest('form')).toBeTruthy();
    expect(composer.closest('.weldagent-composer-vt')).toBeTruthy();
    expect(screen.getByRole('button', { name: tChat.send })).toHaveAttribute('type', 'submit');
    expect(screen.getByText(tChat.emptyTitle)).toBeTruthy();
  });

  it('shows the prompt from the home page right away while its conversation is created', () => {
    state.search = { prompt: 'Summarize my inbox' };
    state.createConversation.mockReturnValue(new Promise(() => {}));

    render(<ChatPage />);

    expect(screen.getByText('Summarize my inbox')).toBeTruthy();
    expect(screen.queryByText(tChat.emptyTitle)).toBeNull();
    expect(state.createConversation).toHaveBeenCalledWith({ name: 'Summarize my inbox' });
  });

  it('does not load history for a conversation it just created', () => {
    state.search = { conversation: 'conv_1', prompt: 'Hi' };
    streamNextReply();

    render(<ChatPage />);

    expect(state.historyArg).toBeNull();
    expect(screen.getByText('Hi')).toBeTruthy();
  });

  it('keeps a reply that is streaming in when saved turns refetch the history', async () => {
    state.search = { conversation: 'conv_1' };
    state.history = [row('m1', 'user', 'First question'), row('m2', 'assistant', 'First answer')];
    const { rerender } = render(<ChatPage />);
    expect(await screen.findByText('First answer')).toBeTruthy();

    const reply = streamNextReply();
    const composer = screen.getByPlaceholderText(tChat.placeholder);
    fireEvent.change(composer, { target: { value: 'Second question' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await act(async () => reply.write('Streaming second'));
    expect(await screen.findByText('Streaming second')).toBeTruthy();

    // Saving the user turn invalidated the query; the refetch has no reply yet.
    state.history = [...state.history, row('m3', 'user', 'Second question')];
    rerender(<ChatPage />);

    expect(screen.getByText('Streaming second')).toBeTruthy();
    expect(screen.getByText('First answer')).toBeTruthy();
    await act(async () => reply.end());
  });
});
