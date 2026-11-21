import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@weldsuite/api-client';

const state = vi.hoisted(() => ({
  dm: { data: undefined, isLoading: false, error: null } as {
    data: unknown;
    isLoading: boolean;
    error: unknown;
  },
}));

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ userId: 'invited_bob@example.com' }) }));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        dm: {
          conversationNotFound: 'Conversation not found',
          invitationPending: "This person hasn't accepted their invitation yet.",
        },
      },
    },
  }),
}));
vi.mock('../lib/message-search', () => ({
  useMessageDeepLink: () => ({ targetMessageId: undefined, clearTarget: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useDmByUser: () => state.dm,
  useMarkChannelAsRead: () => ({ mutate: vi.fn() }),
  weldchatKeys: { channels: () => ['channels'], dms: () => ['dms'] },
  mergeMessageIntoCache: vi.fn(),
  updateMessageInCache: vi.fn(),
  removeMessageFromCache: vi.fn(),
}));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('@/hooks/weldchat/use-weldchat-room', () => ({ useWeldChatRoom: () => ({ client: null }) }));
vi.mock('@/hooks/weldchat/use-weldchat-messages-realtime', () => ({ useWeldChatMessagesRealtime: () => {} }));
vi.mock('@/hooks/weldchat/use-weldchat-realtime', () => ({ useWeldChatRealtime: () => {} }));
vi.mock('@/hooks/weldchat/use-weldchat-presence', () => ({ useWeldChatPresence: () => {} }));
vi.mock('@/hooks/weldchat/use-mark-read-on-open', () => ({ useMarkReadOnOpen: () => null }));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: vi.fn(), closeAll: vi.fn() }) }));
vi.mock('@/contexts/weldchat-call-context', () => ({
  useWeldChatCall: () => ({ status: 'idle', channelId: null, isFullscreen: false, isPiP: false }),
}));
vi.mock('@/components/entity-sheet/use-entity-sheet', () => ({
  useEntitySheet: () => ({ isOpen: false, close: vi.fn() }),
}));
vi.mock('../components/chat-context', () => ({
  useChatContext: () => ({ rightPanel: null, setActiveChannelId: vi.fn() }),
}));
vi.mock('../components/chat-page-skeleton', () => ({ ChatPageSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock('../components/channel-header', () => ({ ChannelHeader: () => <div data-testid="channel-header" /> }));
vi.mock('../components/pinned-messages-bar', () => ({ PinnedMessagesBar: () => null }));
vi.mock('../components/message-list', () => ({ MessageList: () => null }));
vi.mock('../components/message-input', () => ({ MessageInput: () => null }));

import DmConversationPage from './conversation-page';

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DmConversationPage />
    </QueryClientProvider>,
  );
}

const invitationPending = new ApiError('conflict', 409, {
  error: { code: 'CONFLICT', message: 'x', details: { reason: 'invitation_pending', userIds: ['invited_bob@example.com'] } },
});

beforeEach(() => {
  state.dm = { data: undefined, isLoading: false, error: null };
});

describe('DmConversationPage', () => {
  it("explains that an invitee can't be messaged yet instead of loading forever", () => {
    state.dm = { data: undefined, isLoading: false, error: invitationPending };
    renderPage();
    expect(screen.getByText("This person hasn't accepted their invitation yet.")).toBeTruthy();
    expect(screen.queryByTestId('skeleton')).toBeNull();
  });

  it('keeps that notice over a DM still in the cache from before', () => {
    state.dm = { data: { data: { id: 'ch_old', type: 'dm', otherMembers: [] } }, isLoading: false, error: invitationPending };
    renderPage();
    expect(screen.getByText("This person hasn't accepted their invitation yet.")).toBeTruthy();
    expect(screen.queryByTestId('channel-header')).toBeNull();
  });

  it('opens the conversation once the DM resolves', () => {
    state.dm = { data: { data: { id: 'ch_dm', type: 'dm', otherMembers: [] } }, isLoading: false, error: null };
    renderPage();
    expect(screen.getByTestId('channel-header')).toBeTruthy();
  });
});
