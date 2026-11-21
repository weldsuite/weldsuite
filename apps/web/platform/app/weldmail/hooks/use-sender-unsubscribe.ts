/**
 * The open email's sender as a mailing list this mailbox can unsubscribe
 * from, for the message view: the subscription behind its Unsubscribe button,
 * and the in-place unsubscribe behind "Report spam and unsubscribe".
 * See docs/plans/weldmail-unsubscribe-in-message.md.
 */

import { toast } from 'sonner';
import type { MailSubscription } from '@weldsuite/app-api-client';
import { useSenderMailSubscription, useUnsubscribeMailSubscription } from '@/hooks/queries/use-mail-queries';
import { interpolate, useI18n } from '@/lib/i18n/provider';
import { notifyUnsubscribed, senderLabel, unsubscribesInPlace } from '../lib/unsubscribe';

export interface SenderUnsubscribe {
  /** The sender's subscription, or null for ordinary mail. */
  subscription: MailSubscription | null;
  /** Still subscribed, and WeldMail can unsubscribe without sending the user to a web page. */
  canUnsubscribeInPlace: boolean;
  /** Unsubscribe by one-click request or email, and toast the outcome. Never throws. */
  unsubscribeInPlace: () => Promise<void>;
  isPending: boolean;
}

export function useSenderUnsubscribe(accountId: string | undefined, senderEmail: string | null | undefined): SenderUnsubscribe {
  const { t } = useI18n();
  const { data } = useSenderMailSubscription(accountId, senderEmail);
  const unsubscribe = useUnsubscribeMailSubscription();
  const subscription = data ?? null;

  const unsubscribeInPlace = async () => {
    if (!subscription) return;
    try {
      const res = await unsubscribe.mutateAsync(subscription.id);
      notifyUnsubscribed(t.mail.subscriptions, subscription, res.data);
    } catch {
      toast.error(interpolate(t.mail.subscriptions.failed, { sender: senderLabel(subscription) }));
    }
  };

  return {
    subscription,
    canUnsubscribeInPlace: subscription?.status === 'active' && unsubscribesInPlace(subscription),
    unsubscribeInPlace,
    isPending: unsubscribe.isPending,
  };
}
