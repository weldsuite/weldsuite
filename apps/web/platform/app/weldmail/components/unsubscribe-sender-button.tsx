/**
 * Gmail-style Unsubscribe beside the sender of an open email. Shown when the
 * sender is a mailing list this mailbox can unsubscribe from; WeldMail then
 * does the unsubscribing (one-click request or unsubscribe email), or opens
 * the sender's page when that is all the sender offers.
 * See docs/plans/weldmail-unsubscribe-in-message.md.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import type { MailSubscription } from '@weldsuite/app-api-client';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useUnsubscribeMailSubscription } from '@/hooks/queries/use-mail-queries';
import { interpolate, useI18n } from '@/lib/i18n/provider';
import {
  canUnsubscribe,
  confirmDescriptionFor,
  isLinkOnly,
  notifyUnsubscribed,
  openInNewTab,
  senderLabel,
} from '../lib/unsubscribe';

export function UnsubscribeSenderButton({
  subscription,
}: Readonly<{ subscription: MailSubscription | null | undefined }>) {
  const { t } = useI18n();
  const ts = t.mail.subscriptions;
  const unsubscribe = useUnsubscribeMailSubscription();
  const [confirming, setConfirming] = useState(false);

  if (!subscription) return null;
  const active = subscription.status === 'active';
  if (active && !canUnsubscribe(subscription)) return null;

  const sender = senderLabel(subscription);

  const handleConfirm = async () => {
    // Open synchronously inside the click so the popup blocker allows it.
    if (isLinkOnly(subscription) && subscription.unsubscribeUrl) openInNewTab(subscription.unsubscribeUrl);
    try {
      const res = await unsubscribe.mutateAsync(subscription.id);
      notifyUnsubscribed(ts, subscription, res.data);
    } catch {
      toast.error(interpolate(ts.failed, { sender }));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      {active ? (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 font-normal text-muted-foreground"
          onClick={() => setConfirming(true)}
          disabled={unsubscribe.isPending}
          title={interpolate(ts.unsubscribeFrom, { sender })}
        >
          {ts.unsubscribe}
        </Button>
      ) : (
        // Kept next to the dialog so the dialog closes normally after the row flips.
        <span className="shrink-0 text-xs text-muted-foreground">{ts.unsubscribed}</span>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={interpolate(ts.confirmTitle, { sender })}
        description={confirmDescriptionFor(ts, subscription)}
        confirmLabel={ts.unsubscribe}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={handleConfirm}
      />
    </>
  );
}
