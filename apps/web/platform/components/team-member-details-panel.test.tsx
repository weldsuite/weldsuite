import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({
  dmByUser: vi.fn(),
}));

const idle = { data: undefined, isLoading: false };
const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/lib/edition', () => ({ isModuleOffered: () => true, isFeatureAvailable: () => true }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }) }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissionsMaybe: () => null }));
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/contexts/presence-context', () => ({ usePresence: () => ({ getStatus: () => undefined }) }));
vi.mock('@/contexts/compose-context', () => ({ useComposeSafe: () => null }));
vi.mock('@/contexts/weldchat-call-context', () => ({ useWeldChatCall: () => ({ startCall: vi.fn() }) }));
vi.mock('@/hooks/queries/use-team-queries', () => ({ useMemberProfile: () => idle }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useDmByUser: (userId: string) => {
    state.dmByUser(userId);
    return { data: userId ? { data: { id: 'ch_dm' } } : undefined, isLoading: false };
  },
  weldchatKeys: { channels: () => ['channels'], dms: () => ['dms'] },
  mergeMessageIntoCache: vi.fn(),
  updateMessageInCache: vi.fn(),
  removeMessageFromCache: vi.fn(),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useMemberApps: () => idle,
  useMemberPermissions: () => idle,
  useWorkspaceRoles: () => idle,
  useMemberWorkingHours: () => idle,
  useUpdateMember: () => mutation,
  useUpdateMemberRole: () => mutation,
  useToggleMemberApp: () => mutation,
  useUpdateMemberWorkingHours: () => mutation,
}));
vi.mock('@/hooks/use-drawer-field-visibility', () => ({
  useDrawerFieldVisibility: () => ({
    isFieldVisible: () => true,
    fields: [],
    fieldVisibility: {},
    toggleField: vi.fn(),
    resetToDefaults: vi.fn(),
  }),
}));
vi.mock('@/hooks/weldchat/use-weldchat-room', () => ({ useWeldChatRoom: () => ({ client: null }) }));
vi.mock('@/hooks/weldchat/use-weldchat-messages-realtime', () => ({ useWeldChatMessagesRealtime: () => {} }));
vi.mock('@/hooks/weldchat/use-weldchat-presence', () => ({ useWeldChatPresence: () => {} }));
vi.mock('@/app/weldchat/components/message-list', () => ({ MessageList: () => null }));
vi.mock('@/app/weldchat/components/message-input', () => ({ MessageInput: () => null }));
vi.mock('@/components/working-hours/working-hours-editor', () => ({ WorkingHoursEditor: () => null, DEFAULT_HOURS: {} }));
vi.mock('@/components/settings/member-app-permissions', () => ({ MemberAppPermissions: () => null }));
vi.mock('@/components/customer-detail/sections/activity-section', () => ({ ActivitySection: () => null }));
vi.mock('@/components/team-member-panel/tabs/overview-tab', () => ({ OverviewTab: () => null }));
vi.mock('@/components/team-member-panel/tabs/common-tab', () => ({ CommonTab: () => null }));
vi.mock('@/components/team-member-panel/tabs/activity-tab', () => ({ ActivityTab: () => null }));
vi.mock('@/components/team-member-panel/role-label', () => ({ getRoleLabel: (role: string) => role }));
vi.mock('@/lib/apps/app-registry', () => ({ APP_REGISTRY: {} }));
vi.mock('@weldsuite/ui/components/drawer-field-settings', () => ({ DrawerFieldSettings: () => null }));
vi.mock('@weldsuite/ui/components/page-tabs', () => ({
  PageTabs: ({ tabs, children }: { tabs: Array<{ id: string; label: string }>; children?: ReactNode }) => (
    <div>
      {tabs.map((tab) => (
        <span key={tab.id} data-testid={`tab-${tab.id}`}>
          {tab.label}
        </span>
      ))}
      {children}
    </div>
  ),
}));

import { TeamMemberDetailsPanel, type TeamMemberDetail } from './team-member-details-panel';

function renderPanel(member: TeamMemberDetail) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamMemberDetailsPanel
        member={member}
        isOpen
        onClose={() => {}}
        canManageMembers={false}
        onRemoveMember={() => {}}
        onMemberUpdated={() => {}}
        context="projects"
        renderContentOnly
        skipAnimation
      />
    </QueryClientProvider>,
  );
}

const ann: TeamMemberDetail = {
  id: 'mbr_ann',
  name: 'Ann',
  email: 'ann@example.com',
  role: 'MEMBER',
  status: 'ACTIVE',
  joinedAt: '2026-01-01T00:00:00.000Z',
  userId: 'user_ann',
} as TeamMemberDetail;

const bob: TeamMemberDetail = {
  id: 'mbr_bob',
  name: 'Bob',
  email: 'bob@example.com',
  role: 'MEMBER',
  status: 'PENDING',
  joinedAt: '2026-01-01T00:00:00.000Z',
  userId: 'invited_bob@example.com',
} as TeamMemberDetail;

beforeEach(() => {
  state.dmByUser.mockReset();
});

describe('TeamMemberDetailsPanel', () => {
  it('offers chat, calls and the Messages tab for a member who joined', () => {
    renderPanel(ann);
    expect(state.dmByUser).toHaveBeenCalledWith('user_ann');
    expect(screen.getByTitle('projects.memberDetails.openChat')).toBeTruthy();
    expect(screen.getByTitle('projects.memberDetails.voiceCall')).toBeTruthy();
    expect(screen.getByTestId('tab-messages')).toBeTruthy();
  });

  it("offers none of them, and resolves no DM, for someone who hasn't accepted their invitation", () => {
    renderPanel(bob);
    expect(state.dmByUser).not.toHaveBeenCalledWith('invited_bob@example.com');
    expect(screen.queryByTitle('projects.memberDetails.openChat')).toBeNull();
    expect(screen.queryByTitle('projects.memberDetails.voiceCall')).toBeNull();
    expect(screen.queryByTestId('tab-messages')).toBeNull();
    expect(screen.getByTestId('tab-profile')).toBeTruthy();
  });
});
