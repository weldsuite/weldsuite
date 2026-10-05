import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/**
 * Search params of the conversation routes. `msg` is a message deep link
 * (`/weldchat/<channelId>?msg=<messageId>`, produced by "Copy message link").
 */
export interface MessageSearch {
  msg?: string;
}

export function validateMessageSearch(search: Record<string, unknown>): MessageSearch {
  return { msg: typeof search.msg === 'string' && search.msg ? search.msg : undefined };
}

/**
 * The `?msg=` deep-link target of the current conversation page, and a way to
 * drop it from the URL once it has been handled (so a remount doesn't jump
 * again, and opening the same link later jumps again).
 *
 * Non-strict on purpose: the same page components also serve the `/preview/*`
 * mirror routes, which don't declare the search param.
 */
export function useMessageDeepLink(): { targetMessageId: string | undefined; clearTarget: () => void } {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const targetMessageId = validateMessageSearch(search).msg;

  const clearTarget = useCallback(() => {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, msg: undefined }),
      replace: true,
    });
  }, [navigate]);

  return { targetMessageId, clearTarget };
}
