import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  userId: 'user_me' as string | null,
  providerImage: 'https://img.provider.test/me.png',
  profile: undefined as { picture: string } | undefined,
  profileError: false,
  members: undefined as Array<{ id?: string; userId: string; picture?: string | null }> | undefined,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ userId: state.userId }),
  useUser: () => ({ user: state.userId ? { id: state.userId, imageUrl: state.providerImage } : undefined }),
}));
vi.mock('@/hooks/queries/use-self-profile-queries', () => ({
  useSelfProfile: () => ({ data: state.profile, isError: state.profileError }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMemberDirectory: () => ({ data: state.members ? { data: state.members } : undefined }),
}));

import { useCurrentUserAvatar, useMemberAvatar } from './use-member-avatar';

beforeEach(() => {
  state.userId = 'user_me';
  state.profile = undefined;
  state.profileError = false;
  state.members = undefined;
});

describe('useCurrentUserAvatar', () => {
  it('shows the picture uploaded in profile settings, not the provider image', () => {
    state.profile = { picture: 'https://cdn.test/avatars/me_2.png' };
    const { result } = renderHook(() => useCurrentUserAvatar());
    expect(result.current).toBe('https://cdn.test/avatars/me_2.png');
  });

  it('falls back to the provider image when the profile has no picture', () => {
    state.profile = { picture: '' };
    const { result } = renderHook(() => useCurrentUserAvatar());
    expect(result.current).toBe('https://img.provider.test/me.png');
  });

  it('falls back to the provider image when the profile cannot be read', () => {
    state.profileError = true;
    const { result } = renderHook(() => useCurrentUserAvatar());
    expect(result.current).toBe('https://img.provider.test/me.png');
  });

  it('shows nothing while the profile loads, so the old image never flashes', () => {
    const { result } = renderHook(() => useCurrentUserAvatar());
    expect(result.current).toBeUndefined();
  });
});

describe('useMemberAvatar', () => {
  it("prefers a teammate's current picture over the one copied onto the row", () => {
    state.members = [{ id: 'wm_1', userId: 'user_ada', picture: 'https://cdn.test/avatars/ada_new.png' }];
    const { result } = renderHook(() => useMemberAvatar('user_ada', 'https://cdn.test/avatars/ada_old.png'));
    expect(result.current).toBe('https://cdn.test/avatars/ada_new.png');
  });

  it('finds a member by workspace member id too', () => {
    state.members = [{ id: 'wm_1', userId: 'user_ada', picture: 'https://cdn.test/avatars/ada.png' }];
    const { result } = renderHook(() => useMemberAvatar('wm_1'));
    expect(result.current).toBe('https://cdn.test/avatars/ada.png');
  });

  it("uses the row's picture while the directory loads and for non-members", () => {
    const { result: loading } = renderHook(() => useMemberAvatar('user_ada', 'https://cdn.test/row.png'));
    expect(loading.current).toBe('https://cdn.test/row.png');

    state.members = [{ userId: 'user_bob', picture: 'https://cdn.test/bob.png' }];
    const { result: guest } = renderHook(() => useMemberAvatar('guest_1', 'https://cdn.test/guest.png'));
    expect(guest.current).toBe('https://cdn.test/guest.png');
  });

  it("resolves the signed-in user's own messages to their profile picture", () => {
    state.profile = { picture: 'https://cdn.test/avatars/me_2.png' };
    state.members = [{ userId: 'user_me', picture: 'https://cdn.test/avatars/me_1.png' }];
    const { result } = renderHook(() => useMemberAvatar('user_me', 'https://cdn.test/avatars/me_0.png'));
    expect(result.current).toBe('https://cdn.test/avatars/me_2.png');
  });

  it('returns nothing without a picture anywhere, so initials show', () => {
    state.members = [{ userId: 'user_ada', picture: null }];
    const { result } = renderHook(() => useMemberAvatar('user_ada'));
    expect(result.current).toBeUndefined();
  });
});
