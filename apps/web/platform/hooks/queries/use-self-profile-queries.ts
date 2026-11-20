/**
 * The signed-in member's own profile — app-api `GET|PUT /api/settings/profile`
 * and `PUT /api/settings/profile/avatar`.
 *
 * One cache entry for the whole app: the profile settings page reads and
 * writes it, and every place that shows the current user's avatar reads its
 * `picture` (through `useCurrentUserAvatar`). That is the column the avatar
 * upload writes (`workspace_members.picture`) and the one the APIs hand to
 * everyone else, so the user sees the same picture their teammates see, and a
 * new upload shows up everywhere at once.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { teamKeys } from '@/hooks/queries/use-team-queries';

/** Shape returned by GET|PUT /api/settings/profile. */
export interface SelfProfile {
  id: string;
  email: string;
  name: string;
  nickname: string;
  picture: string;
  phone: string;
  company: string;
  jobTitle: string;
  bio: string;
  timezone: string;
}

/** Fields PUT /api/settings/profile accepts. */
export interface UpdateSelfProfileInput {
  name?: string;
  nickname?: string;
  phone?: string;
  jobTitle?: string;
  bio?: string;
  timezone?: string;
}

export interface UploadSelfAvatarInput {
  /** A `data:<mime>;base64,<payload>` URL, as FileReader.readAsDataURL makes it. */
  file: string;
  fileName?: string;
  contentType?: string;
}

export const selfProfileKeys = {
  profile: ['settings', 'profile', 'self'] as const,
};

/** Avatars read this on every mount; a minute keeps that from refetching each time. */
const SELF_PROFILE_STALE_MS = 60_000;

export function useSelfProfile(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: selfProfileKeys.profile,
    enabled,
    staleTime: SELF_PROFILE_STALE_MS,
    queryFn: async () => {
      const client = await getClient();
      const { data } = await client.get<{ data: SelfProfile }>('/settings/profile');
      return data;
    },
  });
}

export function useUpdateSelfProfile() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateSelfProfileInput) => {
      const client = await getClient();
      const { data } = await client.put<{ data: SelfProfile }>('/settings/profile', input);
      return data;
    },
    onSuccess: (profile) => {
      if (profile) queryClient.setQueryData(selfProfileKeys.profile, profile);
      void invalidateMemberDirectories(queryClient);
    },
  });
}

export function useUploadSelfAvatar() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadSelfAvatarInput) => {
      const client = await getClient();
      const { data } = await client.put<{ data: { imageUrl: string } }>('/settings/profile/avatar', input);
      return data?.imageUrl ?? null;
    },
    onSuccess: (imageUrl) => {
      if (!imageUrl) return;
      queryClient.setQueryData<SelfProfile | undefined>(selfProfileKeys.profile, (prev) =>
        prev ? { ...prev, picture: imageUrl } : prev,
      );
      // Teammate lists, pickers and panels read pictures from the member
      // directory; refetch them so the new avatar replaces the old one there too.
      void invalidateMemberDirectories(queryClient);
    },
  });
}

function invalidateMemberDirectories(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['settings', 'members'] }),
    queryClient.invalidateQueries({ queryKey: teamKeys.all }),
  ]);
}
