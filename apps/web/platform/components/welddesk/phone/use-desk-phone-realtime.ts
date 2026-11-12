import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useTopic } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime';
import { useUser } from '@/lib/auth';
import { usePathname, useRouter } from '@/lib/router';
import {
  deskPhoneConversationPath,
  isConversationOpen,
  isDeskPhoneEndedReason,
  textOrNull,
} from './desk-phone-events';
import { deskPhoneEndedAtom, deskPhoneIncomingAtom } from './desk-phone-state';

/**
 * The member's personal inbox topic: `phone.incoming` (the server is dialing
 * this browser), `phone.answered` (this member won the call: open its
 * conversation) and `phone.ended` (a ring that ended without this member).
 * Mount once, app-wide.
 */
export function useDeskPhoneRealtime(): void {
  const { user } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const setIncoming = useSetAtom(deskPhoneIncomingAtom);
  const setEnded = useSetAtom(deskPhoneEndedAtom);

  const handle = useCallback(
    (event: WorkspaceEvent<Record<string, unknown> | null>) => {
      const data = event.data ?? {};
      const callId = textOrNull(data.callId);
      if (!callId) return;

      if (event.event === 'phone.incoming') {
        setEnded(null);
        setIncoming({
          callId,
          conversationId: textOrNull(data.conversationId),
          fromNumber: textOrNull(data.fromNumber) ?? '',
          callerName: textOrNull(data.callerName),
          customerName: textOrNull(data.customerName),
          departmentId: textOrNull(data.departmentId),
          waitingSince: textOrNull(data.waitingSince) ?? new Date().toISOString(),
          receivedAt: Date.now(),
        });
        return;
      }

      if (event.event === 'phone.ended') {
        if (isDeskPhoneEndedReason(data.reason)) {
          setEnded({ callId, reason: data.reason, at: Date.now() });
        }
        return;
      }

      if (event.event === 'phone.answered') {
        const conversationId = textOrNull(data.conversationId);
        if (conversationId && !isConversationOpen(pathname, conversationId)) {
          router.push(deskPhoneConversationPath(conversationId));
        }
      }
    },
    [pathname, router, setEnded, setIncoming],
  );

  useTopic<Record<string, unknown> | null>(user?.id ? `inbox.${user.id}` : '', handle);
}
