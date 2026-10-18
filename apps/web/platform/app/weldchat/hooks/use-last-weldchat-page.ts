import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname } from '@/lib/router';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import {
  preferencesKey,
  useUpdateWeldchatLastPath,
  useUserPreferences,
  type UserPreferences,
} from '@/hooks/queries/use-settings-queries';
import { useChannel, useDmByUser } from '@/hooks/queries/use-weldchat-queries';
import { parseLastWeldChatPage } from '../lib/last-page';

/**
 * Remember the WeldChat page the user is on, so opening WeldChat again from the
 * app rail (or anything else that links to `/weldchat`) reopens it. Writes only
 * when the page changes, never in the unauthenticated preview mirror.
 */
export function useRememberWeldChatPage(enabled: boolean) {
  const pathname = usePathname();
  const inPreview = usePreviewMode() !== null;
  const queryClient = useQueryClient();
  const { mutate: saveLastPath } = useUpdateWeldchatLastPath();
  // Last path handled here, so a failed write (which rolls the cache back)
  // can't turn into a retry loop.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || inPreview) return;
    const page = parseLastWeldChatPage(pathname);
    if (!page || page.path === handled.current) return;
    handled.current = page.path;
    const stored = queryClient.getQueryData<UserPreferences>(preferencesKey)?.uiPreferences?.weldchatLastPath;
    if (stored !== page.path) saveLastPath(page.path);
  }, [enabled, inPreview, pathname, queryClient, saveLastPath]);
}

/**
 * Where `/weldchat` should land: the remembered page while it still exists for
 * this user, `null` when there is none (the caller opens the default channel),
 * `undefined` while that is being checked. A channel or DM is checked against
 * the server, not the persisted cache, so a deleted channel or one the user
 * lost access to falls back instead of opening a "not found" page.
 */
export function useLastWeldChatPage(): string | null | undefined {
  const { data: preferences, isLoading } = useUserPreferences();
  const page = parseLastWeldChatPage(preferences?.uiPreferences?.weldchatLastPath);
  const channel = useChannel(page?.kind === 'channel' ? page.channelId : '', { fresh: true });
  const dm = useDmByUser(page?.kind === 'dm' ? page.userId : '', { fresh: true });

  if (isLoading) return undefined;
  if (!page) return null;
  if (page.kind === 'page') return page.path;
  const check = page.kind === 'channel' ? channel : dm;
  if (!check.isFetchedAfterMount || check.isFetching) return undefined;
  return check.isSuccess ? page.path : null;
}
