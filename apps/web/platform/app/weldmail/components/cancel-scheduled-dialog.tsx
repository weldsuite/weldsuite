import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import {
  cancelScheduledToDraft,
  droppedAttachmentCount,
  loadScheduledMessage,
  type ScheduledMessage,
} from '../lib/cancel-scheduled';

interface ScheduledTarget {
  accountId: string;
  messageId: string;
}

interface PendingCancel extends ScheduledTarget {
  message: ScheduledMessage;
}

/**
 * Cancelling a scheduled mail asks first, then puts the mail back in Drafts.
 * The mail is read before asking: drafts cannot hold attachments yet
 * (TASK-1448), so a mail with attachments says how many will not come along,
 * and only a confirm that says so lets them go. Shared by the reading-pane
 * banner, the list's context menu and the Scheduled page. Render `dialog`
 * once; `requestCancel` opens it.
 */
export function useCancelScheduledEmail(onCancelled?: (target: ScheduledTarget) => void) {
  const { t, plural } = useI18n();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingCancel | null>(null);

  const requestCancel = async (accountId: string, messageId: string) => {
    const loaded = await loadScheduledMessage(accountId, messageId);
    if (!loaded.success) {
      toast.error(loaded.error || t.mail.scheduled.failedToCancelScheduled);
      return;
    }
    setPending({ accountId, messageId, message: loaded.message });
  };

  const confirm = async () => {
    if (!pending) return;
    const result = await cancelScheduledToDraft(pending.accountId, pending.messageId, pending.message);
    if (!result.success) {
      toast.error(result.error || t.mail.scheduled.failedToCancelScheduled);
      return;
    }
    toast.success(t.mail.scheduled.movedToDrafts);
    setPending(null);
    void queryClient.invalidateQueries({ queryKey: ['mail'] });
    window.dispatchEvent(new Event('mail:refresh'));
    onCancelled?.({ accountId: pending.accountId, messageId: pending.messageId });
  };

  const dropped = pending ? droppedAttachmentCount(pending.message) : 0;
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={t.mail.scheduled.cancelConfirmTitle}
      description={
        <>
          {t.mail.scheduled.cancelConfirmDescription}
          {dropped > 0 && (
            <span className="mt-2 block font-medium text-foreground">
              {plural(dropped, t.mail.scheduled.cancelDropsAttachments)}
            </span>
          )}
        </>
      }
      confirmLabel={dropped > 0 ? t.mail.scheduled.cancelConfirmActionWithoutAttachments : t.mail.scheduled.cancelConfirmAction}
      cancelLabel={t.mail.scheduled.keepScheduled}
      variant={dropped > 0 ? 'destructive' : 'default'}
      onConfirm={confirm}
    />
  );

  return {
    requestCancel: (accountId: string, messageId: string) => void requestCancel(accountId, messageId),
    dialog,
  };
}
