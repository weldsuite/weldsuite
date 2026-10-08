import { useEffect, useRef, useState } from 'react';
import { useMarkChannelAsRead } from '@/hooks/queries/use-weldchat-queries';
import { mergeUnreadMarker, type UnreadMarker } from '@/app/weldchat/lib/unread-divider';

/**
 * Marks a channel (or DM) read when it opens, and returns where this visit's
 * "New messages" line goes (see `unread-divider.ts`), or null for no line.
 * Marking read again while the channel stays open (as new messages arrive)
 * does not move the line.
 */
export function useMarkReadOnOpen(channelId: string | null | undefined): UnreadMarker | null {
  const { mutateAsync: markAsRead } = useMarkChannelAsRead();
  const [marker, setMarker] = useState<UnreadMarker | null | undefined>(undefined);
  // The channel on screen now, so an answer for one the user already left is dropped.
  const shownRef = useRef(channelId);
  shownRef.current = channelId;

  useEffect(() => {
    if (!channelId) return;
    setMarker(undefined);
    markAsRead(channelId)
      .then((res) => {
        const result = res?.data;
        if (!result?.lastReadAt || !shownRef.current) return;
        const shown = shownRef.current;
        setMarker((current) =>
          mergeUnreadMarker(current, shown, {
            channelId,
            since: result.previousLastReadAt ?? null,
            until: result.lastReadAt,
          }),
        );
      })
      .catch(() => {
        // Marking read is best effort; without an answer there is simply no line.
      });
  }, [channelId, markAsRead]);

  return marker && marker.channelId === channelId ? marker : null;
}
