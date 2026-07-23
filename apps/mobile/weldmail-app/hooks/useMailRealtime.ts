/**
 * Subscribe to live mail events from the WorkspaceHub.
 *
 * The server publishes `mail:new` events to the topic `mail.{userId}` whenever
 * a new email is delivered (see apps/workers/mail-inbound-worker/src/lib/realtime.ts).
 * This hook subscribes to that topic and triggers an inbox refresh via
 * MailContext.refreshMail() so the existing list re-fetches without the user
 * having to pull-to-refresh manually.
 *
 * De-duplication: refreshMail() only bumps a counter; rapid calls are safe
 * because the inbox fetch in app/index.tsx is keyed on that counter and React
 * will batch closely-spaced state updates in the same event loop tick.
 *
 * Must be mounted inside both RealtimeProvider and MailProvider.
 */

import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/expo';
import { useTopic } from '@weldsuite/realtime/react';
import { useMail } from '@/contexts/MailContext';
import type { WorkspaceEvent } from '@weldsuite/realtime';

interface MailNewEventData {
  messageId?: string;
  accountId?: string;
}

/**
 * Internal component helper — call as a hook inside a small child component
 * mounted in the provider tree (see MailRealtimeWatcher in app/_layout.tsx).
 */
export function useMailRealtime() {
  const { userId } = useAuth();
  const { refreshMail } = useMail();

  // Keep a stable ref so useTopic's handler never stales even if refreshMail
  // identity changes (it's useCallback-memoised in MailContext, but belt+braces).
  const refreshRef = useRef(refreshMail);
  refreshRef.current = refreshMail;

  // Topic is user-scoped: `mail.{userId}`.
  // When userId is null (signed out) we subscribe to a sentinel that will never
  // receive events; the RealtimeProvider itself also skips connecting when
  // signed out, so this is purely defensive.
  const topic = userId ? `mail.${userId}` : 'mail.__none__';

  useTopic<MailNewEventData>(topic, (event: WorkspaceEvent<MailNewEventData>) => {
    if (event.event === 'mail:new') {
      refreshRef.current();
    }
  });
}
