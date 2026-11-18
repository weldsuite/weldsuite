import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  profile: undefined as Record<string, unknown> | undefined,
  dmByUser: vi.fn(),
}));

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/lib/edition', () => ({ isModuleOffered: () => true, isFeatureAvailable: () => true }));
vi.mock('@/contexts/presence-context', () => ({ usePresence: () => ({ getStatus: () => undefined }) }));
vi.mock('@/contexts/compose-context', () => ({ useComposeSafe: () => null }));
vi.mock('@/contexts/weldchat-call-context', () => ({
  useWeldChatCallOptional: () => ({ startCall: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-team-queries', () => ({
  useMemberProfile: () => ({ data: state.profile, isLoading: false }),
}));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useDmByUser: (userId: string) => {
    state.dmByUser(userId);
    return { data: userId ? { data: { id: 'ch_dm' } } : undefined };
  },
}));
// Only the header actions matter here: the shell renders just them, and the
// menu renders its items inline instead of in a portal on open.
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({ actions }: { actions?: ReactNode }) => <div>{actions}</div>,
}));
vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/object-panel', () => ({
  ObjectPanelTabs: () => null,
  useObjectPanelShell: () => ({ entityDetailViewProps: {}, mode: 'panel' }),
  useObjectPanelTabConfig: () => ({}),
}));
vi.mock('@/components/team-member-panel/tabs/overview-tab', () => ({ OverviewTab: () => null }));
vi.mock('@/components/team-member-panel/tabs/common-tab', () => ({ CommonTab: () => null }));
vi.mock('@/components/team-member-panel/tabs/activity-tab', () => ({ ActivityTab: () => null }));

import { TeamMemberPanel } from './team-member-panel';
import type { ObjectPanelComponentProps } from '@/components/object-panel';

function renderPanel() {
  return render(<TeamMemberPanel {...({ id: String(state.profile?.userId) } as ObjectPanelComponentProps)} />);
}

beforeEach(() => {
  state.dmByUser.mockReset();
});

describe('TeamMemberPanel actions', () => {
  it('offers chat and calls for a member who joined', () => {
    state.profile = { id: 'mbr_ann', userId: 'user_ann', name: 'Ann', email: 'ann@example.com', status: 'ACTIVE' };
    renderPanel();
    expect(state.dmByUser).toHaveBeenLastCalledWith('user_ann');
    expect(screen.getByText('sweep.shared.openChat')).toBeTruthy();
    expect(screen.getByText('sweep.entities.call')).toBeTruthy();
  });

  it("offers neither, and resolves no DM, for someone who hasn't accepted their invitation", () => {
    state.profile = {
      id: 'mbr_bob',
      userId: 'invited_bob@example.com',
      name: 'Bob',
      email: 'bob@example.com',
      status: 'PENDING',
    };
    renderPanel();
    expect(state.dmByUser).toHaveBeenLastCalledWith('');
    expect(state.dmByUser).not.toHaveBeenCalledWith('invited_bob@example.com');
    expect(screen.queryByText('sweep.shared.openChat')).toBeNull();
    expect(screen.queryByText('sweep.entities.call')).toBeNull();
    // Mail still works for an invitee.
    expect(screen.getByText('sweep.entities.composeEmail')).toBeTruthy();
  });
});
