import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEventHandler, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  canInviteAgents: true,
  canInviteExternal: false,
  channelType: 'public',
  members: [
    { userId: 'user_1', name: 'Gert', email: 'g@example.com', memberType: 'user', role: 'owner' },
    { userId: 'agt_1', name: 'Task Researcher', memberType: 'agent', role: 'member', agentIcon: null },
  ] as Array<Record<string, unknown>>,
  openAgentProfile: vi.fn(),
  openUserProfile: vi.fn(),
  removeAgent: vi.fn(),
  removeMember: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@clerk/clerk-react', () => ({ useUser: () => ({ user: { id: 'user_me' } }) }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canInviteExternal }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useChannel: () => ({ data: { data: { type: state.channelType } } }),
  useChannelMembers: () => ({ data: { data: state.members }, isLoading: false }),
  useRemoveChannelMember: () => ({ mutate: state.removeMember }),
  useRemoveChannelAgent: () => ({ mutateAsync: state.removeAgent }),
}));
vi.mock('@/contexts/presence-context', () => ({ usePresence: () => ({ presenceMap: {} }) }));
vi.mock('@/app/weldchat/components/chat-context', () => ({
  useChatContext: () => ({ openAgentProfile: state.openAgentProfile, openUserProfile: state.openUserProfile }),
}));
vi.mock('@/app/weldchat/components/invite-agent-picker', () => ({
  useCanInviteAgents: () => state.canInviteAgents,
  InviteAgentPicker: () => <div data-testid="invite-agent-picker" />,
}));
vi.mock('./invite-people-dialog', () => ({ InvitePeopleDialog: () => null }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        guest: { badge: 'Guest', tooltip: 'Guest' },
        memberList: {
          inviteAgent: 'Invite an agent',
          agentActions: 'Agent actions',
          viewAgentProfile: 'View agent profile',
          removeAgentConfirm: 'Remove agent',
          removeAgentTitle: 'Remove {name} from this chat?',
          removeAgentDescription: '{name} stops answering here.',
          agentRemoved: '{name} was removed',
          removeAgentFailed: 'Could not remove {name}',
        },
      },
    },
  }),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: state.toastError } }));

// The list shell is shared UI with its own tests; here it only has to place the rows and the buttons.
vi.mock('@/components/entity-list', () => ({
  EntityList: ({
    items,
    renderRow,
    actionButtons,
  }: {
    items: unknown[];
    renderRow: (item: unknown) => ReactNode;
    actionButtons?: ReactNode;
  }) => (
    <div>
      {actionButtons}
      {items.map((item, i) => (
        <div key={i}>{renderRow(item)}</div>
      ))}
    </div>
  ),
}));

// Radix menus need pointer APIs jsdom lacks: render the menu inline.
vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  // Radix portals the content but React still bubbles its clicks to the row: keep the handler.
  DropdownMenuContent: ({ children, onClick }: { children: ReactNode; onClick?: MouseEventHandler }) => (
    <div role="menu" onClick={onClick}>
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: ReactNode;
    onSelect?: () => void;
    'data-testid'?: string;
  }) => (
    <button type="button" role="menuitem" data-testid={rest['data-testid']} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

import { ChannelPeopleTab } from './channel-people-tab';

beforeEach(() => {
  state.canInviteAgents = true;
  state.canInviteExternal = false;
  state.channelType = 'public';
  state.openAgentProfile.mockReset();
  state.openUserProfile.mockReset();
  state.removeAgent.mockReset();
  state.removeAgent.mockResolvedValue(undefined);
  state.removeMember.mockReset();
  state.toastSuccess.mockReset();
  state.toastError.mockReset();
});

describe('ChannelPeopleTab agents', () => {
  it('offers "Invite an agent" and opens the picker', () => {
    render(<ChannelPeopleTab channelId="ch_1" />);
    expect(screen.queryByTestId('invite-agent-picker')).toBeNull();

    fireEvent.click(screen.getByTestId('invite-agent-button'));
    expect(screen.getByTestId('invite-agent-picker')).toBeTruthy();

    fireEvent.click(screen.getByTestId('invite-agent-button'));
    expect(screen.queryByTestId('invite-agent-picker')).toBeNull();
  });

  it('does not offer it to someone who may not use agents', () => {
    state.canInviteAgents = false;
    render(<ChannelPeopleTab channelId="ch_1" />);
    expect(screen.queryByTestId('invite-agent-button')).toBeNull();
    expect(screen.queryByTestId('chat-agent-remove')).toBeNull();
  });

  it('opens the agent profile from the row and from its menu', () => {
    render(<ChannelPeopleTab channelId="ch_1" />);

    fireEvent.click(screen.getByText('Task Researcher'));
    expect(state.openAgentProfile).toHaveBeenCalledWith('agt_1');

    state.openAgentProfile.mockClear();
    fireEvent.click(screen.getByText('View agent profile'));
    expect(state.openAgentProfile).toHaveBeenCalledWith('agt_1');
    // The row's own click must not fire a second time for the menu click.
    expect(state.openAgentProfile).toHaveBeenCalledTimes(1);
  });

  it('gives only agent rows an agent menu', () => {
    render(<ChannelPeopleTab channelId="ch_1" />);
    expect(screen.getAllByTestId('chat-agent-menu')).toHaveLength(1);
  });

  it('asks before removing an agent, and removes it on confirm', async () => {
    render(<ChannelPeopleTab channelId="ch_1" />);

    fireEvent.click(screen.getByTestId('chat-agent-remove'));
    expect(screen.getByText('Remove Task Researcher from this chat?')).toBeTruthy();
    expect(state.removeAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent', hidden: false }));
    await waitFor(() => expect(state.removeAgent).toHaveBeenCalledWith({ channelId: 'ch_1', agentId: 'agt_1' }));
    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith('Task Researcher was removed'));
    expect(state.removeMember).not.toHaveBeenCalled();
  });

  it('does not remove the agent when the confirmation is cancelled', () => {
    render(<ChannelPeopleTab channelId="ch_1" />);

    fireEvent.click(screen.getByTestId('chat-agent-remove'));
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.cancel' }));
    expect(state.removeAgent).not.toHaveBeenCalled();
  });

  it('says so when the agent could not be removed', async () => {
    state.removeAgent.mockRejectedValue(new Error('nope'));
    render(<ChannelPeopleTab channelId="ch_1" />);

    fireEvent.click(screen.getByTestId('chat-agent-remove'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Could not remove Task Researcher'));
  });
});
