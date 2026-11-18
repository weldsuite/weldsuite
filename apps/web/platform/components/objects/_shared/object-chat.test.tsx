import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/auth', () => ({ useUser: () => ({ user: null }) }));
vi.mock('@/app/weldchat/components/message-input', () => ({
  MessageInput: ({ channelId }: { channelId: string }) => <div data-testid={channelId ? 'live-composer' : 'first-composer'} />,
}));
vi.mock('@/app/weldchat/components/message-list', () => ({ MessageList: () => <div data-testid="message-list" /> }));
vi.mock('@/app/weldchat/components/message-item', () => ({ MessageItem: () => null }));
vi.mock('@/app/weldchat/components/record-chat-panel-bar', () => ({ RecordChatPanelBar: () => null }));
vi.mock('@/components/entity-chat/entity-chat-header', () => ({ EntityChatHeader: () => null }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  mergeMessageIntoCache: vi.fn(),
  updateMessageInCache: vi.fn(),
  removeMessageFromCache: vi.fn(),
  useWorkspaceMembers: () => ({ data: { data: [] } }),
  weldchatKeys: { messages: (id: string) => ['weldchat', 'messages', id], channels: () => ['weldchat', 'channels'] },
}));
vi.mock('@/hooks/weldchat/use-weldchat-room', () => ({ useWeldChatRoom: () => ({ client: null }) }));
vi.mock('@/hooks/weldchat/use-weldchat-messages-realtime', () => ({ useWeldChatMessagesRealtime: vi.fn() }));
vi.mock('@/hooks/weldchat/use-weldchat-realtime', () => ({ useWeldChatRealtime: vi.fn() }));
vi.mock('@/hooks/weldchat/use-weldchat-presence', () => ({ useWeldChatPresence: vi.fn() }));

import { ObjectChatShell } from './object-chat';

const LOADING = 'sweep.entities.loadingChat';

type ChannelQuery = UseQueryResult<{ data: null }, unknown>;
const loading = { isLoading: true, data: undefined } as unknown as ChannelQuery;
const noChat = { isLoading: false, data: { data: null } } as unknown as ChannelQuery;
const failed = { isLoading: false, data: undefined, isError: true } as unknown as ChannelQuery;

function setup() {
  const client = new QueryClient();
  return function view(companyId: string, channelQuery: ChannelQuery) {
    return (
      <QueryClientProvider client={client}>
        <ObjectChatShell
          channelQuery={channelQuery}
          channelQueryKey={['companies', companyId, 'channel']}
          onSendFirstMessage={vi.fn()}
          hideHeader
        />
      </QueryClientProvider>
    );
  };
}

describe('ObjectChatShell loading state (TASK-1461)', () => {
  it('shows the loader again, not the first-message composer, when it moves to another record', () => {
    const view = setup();
    const { rerender } = render(view('company_a', noChat));
    expect(screen.getByTestId('first-composer')).toBeInTheDocument();

    rerender(view('company_b', loading));
    expect(screen.getByText(LOADING)).toBeInTheDocument();
    expect(screen.queryByTestId('first-composer')).not.toBeInTheDocument();
  });

  it('keeps the composer mounted while a failed lookup of the same record is retried', () => {
    const view = setup();
    const { rerender } = render(view('company_c', failed));
    expect(screen.getByTestId('first-composer')).toBeInTheDocument();

    rerender(view('company_c', loading));
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
    expect(screen.getByTestId('first-composer')).toBeInTheDocument();
  });
});
