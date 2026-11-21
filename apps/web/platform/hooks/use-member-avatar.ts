/**
 * Which picture to show for a person in the platform.
 *
 * A member's avatar is their account picture (master `users.image_url`, ADR
 * SEC-020): what the profile settings page uploads to, and what every API
 * hands out as `picture` for authors, assignees and participants. Two sources
 * used to disagree with it:
 *
 * - the signed-in user's own avatar was read from the sign-in provider
 *   (`useUser().user.imageUrl`), which an upload in settings never changes;
 * - rows that copy the author's picture when they are written (chat messages,
 *   notes) keep the old picture after the member uploads a new one.
 *
 * These hooks read the live value instead: the current user's from their own
 * profile, everyone else's from the workspace member directory, with the
 * row's copy only as a fallback while those load.
 */

import type { WorkspaceMember } from '@/hooks/queries/use-settings-queries';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import { useSelfProfile } from '@/hooks/queries/use-self-profile-queries';
import { useAuth, useUser } from '@/lib/auth';

/** Shared by every avatar on screen; refetched when a picture changes (see useUploadSelfAvatar). */
const DIRECTORY_STALE_MS = 5 * 60_000;

/**
 * The signed-in user's avatar URL, the same one settings shows and teammates
 * see. Undefined while it loads (the avatar shows its initials meanwhile); the
 * provider's image only when the profile cannot be read or has no picture.
 */
export function useCurrentUserAvatar(): string | undefined {
  const { user } = useUser();
  const { data: profile, isError } = useSelfProfile(!!user);
  if (profile) return profile.picture || user?.imageUrl || undefined;
  if (isError) return user?.imageUrl || undefined;
  return undefined;
}

type PictureMap = ReadonlyMap<string, string | null>;

const EMPTY_PICTURES: PictureMap = new Map();
const pictureMaps = new WeakMap<readonly WorkspaceMember[], PictureMap>();

/** Built once per directory response, however many avatars read it. */
function picturesFor(members: readonly WorkspaceMember[]): PictureMap {
  let map = pictureMaps.get(members);
  if (!map) {
    const next = new Map<string, string | null>();
    for (const member of members) {
      const picture = member.picture || null;
      if (member.userId) next.set(member.userId, picture);
      if (member.id) next.set(member.id, picture);
    }
    map = next;
    pictureMaps.set(members, map);
  }
  return map;
}

/** Workspace members' current pictures, keyed by user id and by member id. */
export function useMemberPictures(enabled = true): PictureMap {
  const { data } = useWorkspaceMemberDirectory(enabled, { staleTime: DIRECTORY_STALE_MS });
  return data?.data ? picturesFor(data.data) : EMPTY_PICTURES;
}

/**
 * The picture to show for a workspace member.
 *
 * @param memberId The member's user id (or workspace member id).
 * @param fallback A picture the row carries (e.g. a message's `authorAvatar`),
 *   used while the directory loads and for people who are not members.
 */
export function useMemberAvatar(memberId: string | null | undefined, fallback?: string | null): string | undefined {
  const { userId } = useAuth();
  const isSelf = !!memberId && memberId === userId;
  const self = useCurrentUserAvatar();
  const pictures = useMemberPictures(!!memberId && !isSelf);
  if (!memberId) return fallback || undefined;
  if (isSelf) return self || fallback || undefined;
  if (pictures.has(memberId)) return pictures.get(memberId) || fallback || undefined;
  return fallback || undefined;
}
