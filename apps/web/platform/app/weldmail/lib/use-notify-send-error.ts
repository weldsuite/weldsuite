import { useCallback } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useCanManageApps } from '@/hooks/queries/use-settings-queries';
import { describeSendError, type SendFailure } from './send-error';

/** The app store page where an owner or admin asks for WeldReach access. */
export const WELDREACH_ACCESS_PATH = '/appstore/weldreach';

/**
 * Shows why a WeldMail send failed: a translated message per backend code with
 * the limit and the reset time, plus the "outreach belongs in WeldReach" notice
 * (and a link to request access) when the guard says so.
 *
 * Only the toast: every compose, reply, forward and scheduled surface keeps its
 * form as it was, so the draft is never lost on a failure.
 *
 * `fallback` is the call site's own "failed to send …" text, used when the
 * failure carries neither a code we know nor a message.
 */
export function useNotifySendError() {
  const { t, language } = useI18n();
  const { data: canManageApps } = useCanManageApps();
  const sending = t.mail.sending;

  return useCallback(
    (failure: SendFailure, fallback: string) => {
      const view = describeSendError(failure, sending.errors, { locale: language, fallback });
      // Only owners and admins reach the app store; everyone else is told who to ask.
      const canRequest = canManageApps !== false;
      const lines = [view.description];
      if (view.suggestWeldReach) {
        lines.push(sending.weldreach.notice);
        if (!canRequest) lines.push(sending.weldreach.askAdmin);
      }
      toast.error(view.title, {
        description: lines.filter(Boolean).join(' ') || undefined,
        duration: view.suggestWeldReach ? 15_000 : 8_000,
        action:
          view.suggestWeldReach && canRequest
            ? {
                label: sending.weldreach.action,
                // A new tab, so the message being written stays open.
                onClick: () => window.open(WELDREACH_ACCESS_PATH, '_blank', 'noopener'),
              }
            : undefined,
      });
    },
    [sending, language, canManageApps],
  );
}
