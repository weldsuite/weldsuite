/**
 * Subscribe to live mail events for a PERSONAL (consumer WeldMail) address.
 *
 * `useMailRealtime` covers workspace addresses through the shared
 * RealtimeProvider, whose socket is org-keyed (`/ws`). A personal account has
 * no Clerk org, so that socket can neither authenticate for it nor carry its
 * events — the inbound worker publishes personal mail to a per-user hub
 * (`personal:<clerkUserId>`) instead.
 *
 * This hook owns a second, short client pointed at `/ws/personal` and refreshes
 * the inbox on `mail:new`, so a personal message lands in the list while the
 * app is open. Push notifications (personal_device_tokens → Expo) cover the
 * backgrounded case; this is only the foreground half.
 *
 * Must be mounted inside MailProvider (for `refreshMail` + `hasPersonalAccount`).
 */

import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/expo';
import { WorkspaceClient } from '@weldsuite/realtime/client';
import type { WorkspaceEvent } from '@weldsuite/realtime';
import { useMail } from '@/contexts/MailContext';

const REALTIME_URL = process.env.EXPO_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

interface MailNewEventData {
  messageId?: string;
  accountId?: string;
}

export function usePersonalMailRealtime() {
  const { userId, getToken } = useAuth();
  const { refreshMail, hasPersonalAccount } = useMail();

  // Stable ref so the subscribe effect doesn't re-run (and reconnect the
  // socket) every time MailContext hands back a new refreshMail identity.
  const refreshRef = useRef(refreshMail);
  refreshRef.current = refreshMail;

  useEffect(() => {
    // No personal address means nothing will ever be published to this hub —
    // don't hold a socket open for it.
    if (!userId || !hasPersonalAccount) return;

    const client = new WorkspaceClient({
      url: `${REALTIME_URL}/ws/personal`,
      getToken: async () => (await getToken()) || '',
    });

    const off = client.on<MailNewEventData>(
      `mail.${userId}`,
      (event: WorkspaceEvent<MailNewEventData>) => {
        if (event.event === 'mail:new') {
          refreshRef.current();
        }
      },
    );

    // `on` registers the topic; connect() replays it once the socket opens and
    // again after every reconnect.
    void client.connect().catch(() => {
      // Non-fatal: mail still loads over REST and push still fires. A failed
      // socket is not worth surfacing to the user.
    });

    return () => {
      off();
      client.disconnect();
    };
  }, [userId, hasPersonalAccount, getToken]);
}
