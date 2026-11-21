/**
 * Gmail-style Unsubscribe under the sender of an open email. Shown when the
 * sender is a mailing list this mailbox can unsubscribe from; WeldMail then
 * does the unsubscribing, or opens the sender's page when that is all the
 * sender offers. Renders nothing for ordinary mail.
 * See docs/plans/weldmail-unsubscribe-in-message.md.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useMail } from '@/contexts/MailContext';
import {
  isLinkOnlySubscription,
  listSubscriptionsCached,
  unsubscribeFromSender,
  type SubscriptionMethod,
  type TenantSubscription,
} from '@/services/mail-tenant';
import {
  canUnsubscribe,
  findSenderSubscription,
  senderLabel,
  unsubscribeConfirmMessage,
  unsubscribeOutcome,
} from '@/utils/unsubscribe';

type Toast = ReturnType<typeof useToast>;

/** Tells the user how the unsubscribe went, opening the sender's page when that is still needed. */
export async function announceUnsubscribe(
  toast: Toast,
  method: SubscriptionMethod,
  url: string | null,
  sender: string,
): Promise<void> {
  const outcome = unsubscribeOutcome(method, url, sender);
  if (outcome.kind === 'success') {
    toast.success(outcome.message);
    return;
  }
  toast.info(outcome.message, 5000);
  if (outcome.openUrl) await WebBrowser.openBrowserAsync(outcome.openUrl);
}

/** The sender's subscription in this mailbox, once the (cached) list has loaded. */
function useSenderSubscription(accountId: string | null | undefined, senderEmail: string | null | undefined) {
  const { accounts } = useMail();
  const account = useMemo(() => accounts.find((a) => a.id === accountId) ?? null, [accounts, accountId]);
  const [subscription, setSubscription] = useState<TenantSubscription | null>(null);

  useEffect(() => {
    setSubscription(null);
    if (!account || !senderEmail) return undefined;
    let cancelled = false;
    listSubscriptionsCached(account)
      .then((items) => {
        if (!cancelled) setSubscription(findSenderSubscription(items, senderEmail) ?? null);
      })
      .catch(() => {
        // No list, no button: the email still reads fine.
      });
    return () => {
      cancelled = true;
    };
  }, [account, senderEmail]);

  return { account, subscription, setSubscription };
}

export default function UnsubscribeSenderChip({ accountId, senderEmail, style }: Readonly<{
  accountId: string | null | undefined;
  senderEmail: string | null | undefined;
  style?: StyleProp<ViewStyle>;
}>) {
  const { colors } = useTheme();
  const toast = useToast();
  const { account, subscription, setSubscription } = useSenderSubscription(accountId, senderEmail);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!account || !subscription) return null;
  const active = subscription.status === 'active';
  if (active && !canUnsubscribe(subscription)) return null;
  const sender = senderLabel(subscription);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const { method, url } = await unsubscribeFromSender(account, subscription.id);
      setSubscription({ ...subscription, status: 'unsubscribed', unsubscribedAt: new Date().toISOString() });
      setConfirming(false);
      await announceUnsubscribe(toast, method, url, sender);
    } catch (err) {
      console.error('Unsubscribe failed:', err);
      toast.error(`Could not unsubscribe from ${sender}`);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <View style={[styles.row, style]}>
      {active ? (
        <Button
          title="Unsubscribe"
          variant="outline"
          size="sm"
          onPress={() => setConfirming(true)}
          disabled={busy}
          accessibilityLabel={`Unsubscribe from ${sender}`}
          style={styles.button}
          textStyle={styles.buttonText}
        />
      ) : (
        <Text style={[styles.status, { color: colors.mutedForeground }]}>Unsubscribed</Text>
      )}
      <ConfirmModal
        visible={confirming}
        title={`Unsubscribe from ${sender}?`}
        message={unsubscribeConfirmMessage(subscription)}
        confirmText={isLinkOnlySubscription(subscription) ? 'Open page' : 'Unsubscribe'}
        variant="destructive"
        loading={busy}
        onConfirm={handleConfirm}
        onCancel={() => !busy && setConfirming(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  button: { height: 28, paddingHorizontal: 10 },
  buttonText: { fontSize: 13 },
  status: { fontSize: 13 },
});
