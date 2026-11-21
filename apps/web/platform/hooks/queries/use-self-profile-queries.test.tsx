import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMock = vi.fn();
const putMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({ get: getMock, put: putMock }),
  }),
}));

/** The signed-in user: an upload re-reads it so its `imageUrl` follows. */
const reloadMock = vi.fn(async () => undefined);
vi.mock('@/lib/auth', () => ({
  useUser: () => ({ user: { reload: reloadMock } }),
}));

import {
  selfProfileKeys,
  useSelfProfile,
  useUpdateSelfProfile,
  useUploadSelfAvatar,
  type SelfProfile,
} from './use-self-profile-queries';
import { teamKeys } from './use-team-queries';

const profile: SelfProfile = {
  id: 'wm_1',
  email: 'ada@acme.test',
  name: 'Ada Lovelace',
  nickname: '',
  picture: 'https://cdn.test/avatars/ada_1.png',
  phone: '',
  company: '',
  jobTitle: 'Engineer',
  bio: '',
  timezone: 'Europe/Amsterdam',
};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe('useSelfProfile', () => {
  it('reads the caller’s own profile', async () => {
    getMock.mockResolvedValue({ data: profile });
    const { result } = renderHook(() => useSelfProfile(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(profile));
    expect(getMock).toHaveBeenCalledWith('/settings/profile');
  });

  it('does not fetch while disabled', () => {
    renderHook(() => useSelfProfile(false), { wrapper });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useUpdateSelfProfile', () => {
  it('stores the saved profile and refreshes the member directories', async () => {
    const saved = { ...profile, name: 'Ada King' };
    putMock.mockResolvedValue({ data: saved });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateSelfProfile(), { wrapper });

    await act(() => result.current.mutateAsync({ name: 'Ada King' }));

    expect(putMock).toHaveBeenCalledWith('/settings/profile', { name: 'Ada King' });
    expect(queryClient.getQueryData(selfProfileKeys.profile)).toEqual(saved);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'members'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: teamKeys.all });
  });
});

describe('useUploadSelfAvatar', () => {
  const upload = { file: 'data:image/png;base64,AAAA', fileName: 'me.png', contentType: 'image/png' };

  it('swaps the new picture into the cached profile and refreshes the member directories', async () => {
    queryClient.setQueryData(selfProfileKeys.profile, profile);
    putMock.mockResolvedValue({ data: { imageUrl: 'https://cdn.test/avatars/ada_2.png' } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUploadSelfAvatar(), { wrapper });

    let imageUrl: string | null = null;
    await act(async () => {
      imageUrl = await result.current.mutateAsync(upload);
    });

    expect(putMock).toHaveBeenCalledWith('/settings/profile/avatar', upload);
    expect(imageUrl).toBe('https://cdn.test/avatars/ada_2.png');
    expect(queryClient.getQueryData<SelfProfile>(selfProfileKeys.profile)?.picture).toBe(
      'https://cdn.test/avatars/ada_2.png',
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'members'] });
    // The upload set the account picture: the signed-in user is re-read too.
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the cache alone when the API returns no picture', async () => {
    queryClient.setQueryData(selfProfileKeys.profile, profile);
    putMock.mockResolvedValue({ data: {} });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUploadSelfAvatar(), { wrapper });

    let imageUrl: string | null = 'unset';
    await act(async () => {
      imageUrl = await result.current.mutateAsync(upload);
    });

    expect(imageUrl).toBeNull();
    expect(queryClient.getQueryData<SelfProfile>(selfProfileKeys.profile)?.picture).toBe(profile.picture);
    expect(invalidate).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('keeps an unloaded profile unloaded', async () => {
    putMock.mockResolvedValue({ data: { imageUrl: 'https://cdn.test/avatars/ada_2.png' } });
    const { result } = renderHook(() => useUploadSelfAvatar(), { wrapper });
    await act(() => result.current.mutateAsync(upload));
    expect(queryClient.getQueryData(selfProfileKeys.profile)).toBeUndefined();
  });
});
