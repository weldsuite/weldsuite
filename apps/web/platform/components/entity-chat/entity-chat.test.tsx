import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  getEntityChannel: vi.fn(),
}));

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/auth', () => ({ useUser: () => ({ user: null }) }));
vi.mock('@/hooks/use-member-avatar', () => ({ useCurrentUserAvatar: () => undefined }));
vi.mock('@/lib/api/domains/weldchat-entity', () => ({
  weldchatEntityApi: { getEntityChannel: mocks.getEntityChannel, sendEntityMessage: vi.fn() },
}));
vi.mock('@/app/weldchat/components/message-input', () => ({
  MessageInput: ({ channelId }: { channelId: string }) => <div data-testid={channelId ? 'live-composer' : 'first-composer'} />,
}));
vi.mock('@/app/weldchat/components/message-list', () => ({ MessageList: () => <div data-testid="message-list" /> }));
vi.mock('@/app/weldchat/components/message-item', () => ({ MessageItem: () => null }));
vi.mock('@/app/weldchat/components/record-chat-panel-bar', () => ({ RecordChatPanelBar: () => null }));
vi.mock('./entity-chat-header', () => ({ EntityChatHeader: () => null }));
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

import { EntityChat } from './entity-chat';

const LOADING = 'sweep.weldchat.entityChat.loadingChat';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (entityId: string) => (
    <QueryClientProvider client={client}>
      <EntityChat entityType="task" entityId={entityId} />
    </QueryClientProvider>
  );
  return { client, view };
}

describe('EntityChat loading state (TASK-1461)', () => {
  it('shows the loader again, not the first-message composer, when it moves to another record', async () => {
    // task_a has no chat yet; task_b's lookup is still on its way.
    mocks.getEntityChannel.mockImplementation((_type: string, id: string) =>
      id === 'task_a' ? Promise.resolve(null) : new Promise(() => {}),
    );
    const { view } = setup();
    const { rerender } = render(view('task_a'));
    expect(await screen.findByTestId('first-composer')).toBeInTheDocument();

    rerender(view('task_b'));
    expect(screen.getByText(LOADING)).toBeInTheDocument();
    expect(screen.queryByTestId('first-composer')).not.toBeInTheDocument();
  });

  it('keeps the composer mounted while a failed lookup of the same record is retried', async () => {
    mocks.getEntityChannel.mockReset();
    mocks.getEntityChannel.mockRejectedValueOnce(new Error('503')).mockImplementation(() => new Promise(() => {}));
    const { client, view } = setup();
    render(view('task_c'));
    expect(await screen.findByTestId('first-composer')).toBeInTheDocument();

    // A refetch of a query without data is a fresh "loading".
    const key = ['entity-channel', 'task', 'task_c'];
    void client.refetchQueries({ queryKey: key });
    await waitFor(() => expect(client.getQueryState(key)?.status).toBe('pending'));
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
    expect(screen.getByTestId('first-composer')).toBeInTheDocument();
  });
});
