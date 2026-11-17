import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { cancelScheduledToDraft } from '../lib/cancel-scheduled';

interface ScheduledTarget {
  accountId: string;
  messageId: string;
}

/**
 * Cancelling a scheduled mail asks first, then puts the mail back in Drafts.
 * Shared by the reading-pane banner, the list's context menu and the
 * Scheduled page. Render `dialog` once; `requestCancel` opens it.
 */
export function useCancelScheduledEmail(onCancelled?: (target: ScheduledTarget) => void) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<ScheduledTarget | null>(null);

  const confirm = async () => {
    if (!target) return;
    const result = await cancelScheduledToDraft(target.accountId, target.messageId);
    if (!result.success) {
      toast.error(result.error || t.mail.scheduled.failedToCancelScheduled);
      return;
    }
    toast.success(t.mail.scheduled.movedToDrafts);
    setTarget(null);
    void queryClient.invalidateQueries({ queryKey: ['mail'] });
    window.dispatchEvent(new Event('mail:refresh'));
    onCancelled?.(target);
  };

  const dialog = (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
      title={t.mail.scheduled.cancelConfirmTitle}
      description={t.mail.scheduled.cancelConfirmDescription}
      confirmLabel={t.mail.scheduled.cancelConfirmAction}
      cancelLabel={t.mail.scheduled.keepScheduled}
      onConfirm={confirm}
    />
  );

  return {
    requestCancel: (accountId: string, messageId: string) => setTarget({ accountId, messageId }),
    dialog,
  };
}
