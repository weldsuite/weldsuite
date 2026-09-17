/**
 * Subscriptions — newsletters and mailing lists a mailbox receives, with
 * Gmail-style one-tap unsubscribe. Works for workspace and personal
 * mailboxes; `services/mail-tenant.ts` picks app-api or personal-api.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { MailX, RefreshCw } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Screen, ScreenHeader } from '@/components/screen';
import { ErrorState, ListSkeleton } from '@/components/data-states';
import { getAvatarColor, useMail } from '@/contexts/MailContext';
import {
  isLinkOnlySubscription,
  listSubscriptions,
  scanSubscriptions,
  unsubscribeFromSender,
  type TenantMailAccount,
  type TenantSubscription,
} from '@/services/mail-tenant';
import { formatMessageDate } from '@/utils/email-format';

type StatusFilter = 'active' | 'unsubscribed';

function senderLabel(sub: TenantSubscription): string {
  return sub.senderName || sub.senderEmail;
}

function confirmMessage(sub: TenantSubscription): string {
  const sender = senderLabel(sub);
  if (sub.oneClick && sub.unsubscribeUrl) return `WeldMail will ask ${sender} to stop sending email to this mailbox.`;
  if (sub.unsubscribeMailto) return `WeldMail will send an unsubscribe request from this mailbox to ${sender}.`;
  return `The unsubscribe page of ${sender} opens in your browser. Finish the steps there.`;
}

export default function SubscriptionsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const { accounts, selectedAccount } = useMail();

  const [account, setAccount] = useState<TenantMailAccount | null>(selectedAccount ?? accounts[0] ?? null);
  const [items, setItems] = useState<TenantSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<TenantSubscription | null>(null);
  const [unsubscribing, setUnsubscribing] = useState(false);

  useEffect(() => {
    if (!account && accounts.length > 0) setAccount(selectedAccount ?? accounts[0]!);
  }, [account, accounts, selectedAccount]);

  const load = useCallback(async () => {
    if (!account) return;
    setLoadError(false);
    try {
      setItems(await listSubscriptions(account));
    } catch (err) {
      console.error('Failed to load subscriptions:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [account]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (s) =>
        s.status === status &&
        (!q ||
          s.senderEmail.includes(q) ||
          (s.senderName ?? '').toLowerCase().includes(q) ||
          (s.lastSubject ?? '').toLowerCase().includes(q)),
    );
  }, [items, status, query]);

  const counts = useMemo(
    () => ({
      active: items.filter((s) => s.status === 'active').length,
      unsubscribed: items.filter((s) => s.status === 'unsubscribed').length,
    }),
    [items],
  );

  const handleScan = async () => {
    if (!account || scanning) return;
    setScanning(true);
    try {
      const res = await scanSubscriptions(account);
      toast.success(`Found ${res.subscriptions} subscriptions in ${res.scanned} emails`);
      await load();
    } catch (err) {
      console.error('Subscription scan failed:', err);
      toast.error('Could not scan this mailbox');
    } finally {
      setScanning(false);
    }
  };

  const handleUnsubscribe = async () => {
    if (!account || !pending) return;
    const sub = pending;
    const sender = senderLabel(sub);
    setUnsubscribing(true);
    try {
      const { method, url } = await unsubscribeFromSender(account, sub.id);
      setItems((prev) =>
        prev.map((s) =>
          s.id === sub.id ? { ...s, status: 'unsubscribed', unsubscribedAt: new Date().toISOString() } : s,
        ),
      );
      if (method === 'one_click') toast.success(`Unsubscribed from ${sender}`);
      else if (method === 'mailto') toast.success(`Unsubscribe request sent to ${sender}`);
      else if (url) {
        toast.info(`Finish unsubscribing on the page of ${sender}`, 5000);
        await WebBrowser.openBrowserAsync(url);
      }
    } catch (err) {
      console.error('Unsubscribe failed:', err);
      toast.error(`Could not unsubscribe from ${sender}`);
    } finally {
      setUnsubscribing(false);
      setPending(null);
    }
  };

  const renderItem = ({ item }: { item: TenantSubscription }) => {
    const sender = senderLabel(item);
    const canUnsubscribe = !!item.unsubscribeUrl || !!item.unsubscribeMailto;
    const stillSending =
      item.status === 'unsubscribed' &&
      !!item.unsubscribedAt &&
      new Date(item.lastReceivedAt) > new Date(item.unsubscribedAt);

    return (
      <View style={[styles.row, { borderBottomColor: colors.border }]}>
        <View style={[styles.avatar, { backgroundColor: getAvatarColor(sender) }]}>
          <Text style={styles.avatarText}>{sender.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.sender, { color: colors.text }]} numberOfLines={1}>
            {sender}
          </Text>
          {item.lastSubject ? (
            <Text style={[styles.subject, { color: colors.mutedForeground }]} numberOfLines={1}>
              {item.lastSubject}
            </Text>
          ) : null}
          <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
            {item.messageCount === 1 ? '1 email' : `${item.messageCount} emails`} · Last{' '}
            {formatMessageDate(item.lastReceivedAt)}
          </Text>
        </View>
        {item.status === 'unsubscribed' ? (
          <Text style={[styles.statusText, { color: stillSending ? colors.destructive : colors.mutedForeground }]}>
            {stillSending ? 'Still sending' : 'Unsubscribed'}
          </Text>
        ) : canUnsubscribe ? (
          <Button
            title="Unsubscribe"
            variant="outline"
            size="sm"
            onPress={() => setPending(item)}
            accessibilityLabel={`Unsubscribe from ${sender}`}
          />
        ) : (
          <Text style={[styles.statusText, { color: colors.mutedForeground }]}>No option</Text>
        )}
      </View>
    );
  };

  const header = (
    <ScreenHeader
      title="Subscriptions"
      subtitle={account?.emailAddress}
      onBack={() => router.back()}
      actions={
        <IconButton
          icon={<RefreshCw size={20} color={colors.text} />}
          accessibilityLabel="Scan mailbox"
          onPress={handleScan}
          disabled={scanning || !account}
        />
      }
      below={
        <View style={styles.below}>
          {accounts.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.accountChips}>
              {accounts.map((a) => {
                const active = a.id === account?.id;
                return (
                  <TouchableOpacity
                    key={a.id}
                    onPress={() => setAccount(a)}
                    style={[
                      styles.chip,
                      { borderColor: colors.border },
                      active && { backgroundColor: colors.text, borderColor: colors.text },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.chipText, { color: active ? colors.background : colors.text }]} numberOfLines={1}>
                      {a.emailAddress}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : null}
          <SearchBar value={query} onChangeText={setQuery} placeholder="Search senders" onClear={() => setQuery('')} />
          <SegmentedControl
            options={[
              { label: `Subscribed (${counts.active})`, value: 'active' },
              { label: `Unsubscribed (${counts.unsubscribed})`, value: 'unsubscribed' },
            ]}
            value={status}
            onValueChange={(v) => setStatus(v as StatusFilter)}
          />
        </View>
      }
    />
  );

  if (!account) {
    return (
      <Screen header={header}>
        <EmptyState title="No mailbox" description="Add an email account to manage subscriptions." />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      {loading ? (
        <ListSkeleton count={8} />
      ) : loadError ? (
        <ErrorState message="Could not load subscriptions" onRetry={() => { setLoading(true); void load(); }} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(s) => s.id}
          renderItem={renderItem}
          contentContainerStyle={visible.length === 0 ? styles.emptyContainer : undefined}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />
          }
          ListEmptyComponent={
            <EmptyState
              icon={<MailX size={40} color={colors.mutedForeground} />}
              title={
                query
                  ? 'No senders match your search'
                  : status === 'active'
                    ? 'No subscriptions found'
                    : 'You have not unsubscribed from anything yet'
              }
              description={
                !query && status === 'active'
                  ? 'Newsletters appear here as they arrive. Scan the mailbox to find the ones you already have.'
                  : undefined
              }
              action={
                !query && status === 'active' ? (
                  <Button title={scanning ? 'Scanning…' : 'Scan mailbox'} onPress={handleScan} loading={scanning} />
                ) : undefined
              }
            />
          }
        />
      )}

      <ConfirmModal
        visible={!!pending}
        title={pending ? `Unsubscribe from ${senderLabel(pending)}?` : ''}
        message={pending ? confirmMessage(pending) : undefined}
        confirmText={pending && isLinkOnlySubscription(pending) ? 'Open page' : 'Unsubscribe'}
        variant="destructive"
        loading={unsubscribing}
        onConfirm={handleUnsubscribe}
        onCancel={() => !unsubscribing && setPending(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  below: {
    gap: 10,
  },
  accountChips: {
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: 240,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  sender: {
    fontSize: 15,
    fontWeight: '600',
  },
  subject: {
    fontSize: 13,
    marginTop: 2,
  },
  meta: {
    fontSize: 12,
    marginTop: 2,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
});
