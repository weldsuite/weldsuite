import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MemberProfile } from '@weldsuite/core-api-client/schemas/member-profile';

const state = vi.hoisted(() => ({
  dmByUser: vi.fn(),
}));

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/contexts/presence-context', () => ({ usePresence: () => ({ getStatus: () => undefined }) }));
vi.mock('@/contexts/weldchat-call-context', () => ({ useWeldChatCall: () => ({ startCall: vi.fn() }) }));
vi.mock('@/lib/edition', () => ({ isModuleOffered: () => true, isFeatureAvailable: () => true }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useDmByUser: (userId: string) => {
    state.dmByUser(userId);
    return { data: userId ? { data: { id: 'ch_dm' } } : undefined };
  },
}));

import { TeamMemberPanelHeader } from './header';

function profile(overrides: Partial<MemberProfile>): MemberProfile {
  return {
    id: 'mbr_1',
    userId: 'user_ann',
    name: 'Ann',
    email: 'ann@example.com',
    picture: null,
    role: 'MEMBER',
    status: 'ACTIVE',
    timezone: 'UTC',
    ...overrides,
  } as MemberProfile;
}

beforeEach(() => {
  state.dmByUser.mockReset();
});

describe('TeamMemberPanelHeader', () => {
  it('offers message and calls for a member who joined', () => {
    render(<TeamMemberPanelHeader profile={profile({})} onClose={() => {}} isSelf={false} />);
    expect(state.dmByUser).toHaveBeenLastCalledWith('user_ann');
    expect(screen.getByTitle('sweep.shared.message')).toBeTruthy();
    expect(screen.getByTitle('sweep.shared.voiceCall')).toBeTruthy();
  });

  it("neither offers nor resolves a DM for someone who hasn't accepted their invitation", () => {
    render(
      <TeamMemberPanelHeader
        profile={profile({ userId: 'invited_ann@example.com', status: 'PENDING' })}
        onClose={() => {}}
        isSelf={false}
      />,
    );
    expect(state.dmByUser).toHaveBeenLastCalledWith('');
    expect(screen.queryByTitle('sweep.shared.message')).toBeNull();
    expect(screen.queryByTitle('sweep.shared.voiceCall')).toBeNull();
  });
});
