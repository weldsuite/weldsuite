/**
 * Subscriptions — newsletters and mailing lists a mailbox receives, with
 * Gmail-style one-tap unsubscribe. Works for workspace and personal
 * mailboxes; `services/mail-tenant.ts` picks app-api or personal-api.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
type ThemeColors = ReturnType<typeof useTheme>['colors'];
type Toast = ReturnType<typeof useToast>;

function senderLabel(sub: TenantSubscription): string {
  return sub.senderName || sub.senderEmail;
}

function confirmMessage(sub: TenantSubscription): string {
  const sender = senderLabel(sub);
  if (sub.oneClick && sub.unsubscribeUrl) return `WeldMail will ask ${sender} to stop sending email to this mailbox.`;
  if (sub.unsubscribeMailto) return `WeldMail will send an unsubscribe request from this mailbox to ${sender}.`;
  return `The unsubscribe page of ${sender} opens in your browser. Finish the steps there.`;
}

/** `q` is the already trimmed + lower-cased search text. */
function matchesQuery(s: TenantSubscription, q: string): boolean {
  return (
    !q ||
    s.senderEmail.includes(q) ||
    (s.senderName ?? '').toLowerCase().includes(q) ||
    (s.lastSubject ?? '').toLowerCase().includes(q)
  );
}

function filterSubscriptions(items: TenantSubscription[], status: StatusFilter, query: string): TenantSubscription[] {
  const q = query.trim().toLowerCase();
  return items.filter((s) => s.status === status && matchesQuery(s, q));
}

function countByStatus(items: TenantSubscription[]) {
  return {
    active: items.filter((s) => s.status === 'active').length,
    unsubscribed: items.filter((s) => s.status === 'unsubscribed').length,
  };
}

function emptyTitle(query: string, status: StatusFilter): string {
  if (query) return 'No senders match your search';
  return status === 'active' ? 'No subscriptions found' : 'You have not unsubscribed from anything yet';
}

/** The mailbox on screen: the selected one, else the first, once accounts have loaded. */
function useActiveAccount(accounts: TenantMailAccount[], selectedAccount: TenantMailAccount | null) {
  const [account, setAccount] = useState<TenantMailAccount | null>(selectedAccount ?? accounts[0] ?? null);

  useEffect(() => {
    if (!account && accounts.length > 0) setAccount(selectedAccount ?? accounts[0]!);
  }, [account, accounts, selectedAccount]);

  return [account, setAccount] as const;
}

function useSubscriptionList(account: TenantMailAccount | null) {
  const [items, setItems] = useState<TenantSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // The account whose list is on screen. A slower response for the mailbox
  // the user just switched away from must not land under the new one (its
  // Unsubscribe would then target the wrong account).
  const activeAccountIdRef = useRef<string | null>(null);
  activeAccountIdRef.current = account?.id ?? null;

  const load = useCallback(async () => {
    if (!account) return;
    const requestedId = account.id;
    setLoadError(false);
    try {
      const next = await listSubscriptions(account);
      if (activeAccountIdRef.current === requestedId) setItems(next);
    } catch (err) {
      if (activeAccountIdRef.current !== requestedId) return;
      console.error('Failed to load subscriptions:', err);
      setLoadError(true);
    } finally {
      if (activeAccountIdRef.current === requestedId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [account]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  return { items, setItems, loading, setLoading, refreshing, setRefreshing, loadError, load };
}

/** Runs a mailbox scan and reports the outcome; never rejects. */
async function performScan(account: TenantMailAccount, toast: Toast, reload: () => Promise<void>): Promise<void> {
  try {
    const res = await scanSubscriptions(account);
    toast.success(`Found ${res.subscriptions} subscriptions in ${res.scanned} emails`);
    await reload();
  } catch (err) {
    console.error('Subscription scan failed:', err);
    toast.error('Could not scan this mailbox');
  }
}

async function announceUnsubscribe(toast: Toast, method: string, url: string | null, sender: string): Promise<void> {
  if (method === 'one_click') toast.success(`Unsubscribed from ${sender}`);
  else if (method === 'mailto') toast.success(`Unsubscribe request sent to ${sender}`);
  else if (url) {
    toast.info(`Finish unsubscribing on the page of ${sender}`, 5000);
    await WebBrowser.openBrowserAsync(url);
  }
}

function markUnsubscribed(items: TenantSubscription[], id: string): TenantSubscription[] {
  return items.map((s) =>
    s.id === id ? { ...s, status: 'unsubscribed', unsubscribedAt: new Date().toISOString() } : s,
  );
}

/** Unsubscribes from one sender and reports the outcome; never rejects. */
async function performUnsubscribe(
  account: TenantMailAccount,
  sub: TenantSubscription,
  toast: Toast,
  setItems: React.Dispatch<React.SetStateAction<TenantSubscription[]>>,
): Promise<void> {
  const sender = senderLabel(sub);
  try {
    const { method, url } = await unsubscribeFromSender(account, sub.id);
    setItems((prev) => markUnsubscribed(prev, sub.id));
    await announceUnsubscribe(toast, method, url, sender);
  } catch (err) {
    console.error('Unsubscribe failed:', err);
    toast.error(`Could not unsubscribe from ${sender}`);
  }
}

function RowStatus({ item, sender, canUnsubscribe, stillSending, colors, onUnsubscribe }: Readonly<{
  item: TenantSubscription;
  sender: string;
  canUnsubscribe: boolean;
  stillSending: boolean;
  colors: ThemeColors;
  onUnsubscribe: (item: TenantSubscription) => void;
}>) {
  if (item.status === 'unsubscribed') {
    return (
      <Text style={[styles.statusText, { color: stillSending ? colors.destructive : colors.mutedForeground }]}>
        {stillSending ? 'Still sending' : 'Unsubscribed'}
      </Text>
    );
  }
  if (canUnsubscribe) {
    return (
      <Button
        title="Unsubscribe"
        variant="outline"
        size="sm"
        onPress={() => onUnsubscribe(item)}
        accessibilityLabel={`Unsubscribe from ${sender}`}
      />
    );
  }
  return <Text style={[styles.statusText, { color: colors.mutedForeground }]}>No option</Text>;
}

function SubscriptionRow({ item, colors, onUnsubscribe }: Readonly<{
  item: TenantSubscription;
  colors: ThemeColors;
  onUnsubscribe: (item: TenantSubscription) => void;
}>) {
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
      <RowStatus
        item={item}
        sender={sender}
        canUnsubscribe={canUnsubscribe}
        stillSending={stillSending}
        colors={colors}
        onUnsubscribe={onUnsubscribe}
      />
    </View>
  );
}

function AccountChips({ accounts, activeId, colors, onSelect }: Readonly<{
  accounts: TenantMailAccount[];
  activeId: string | undefined;
  colors: ThemeColors;
  onSelect: (account: TenantMailAccount) => void;
}>) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.accountChips}>
      {accounts.map((a) => {
        const active = a.id === activeId;
        return (
          <TouchableOpacity
            key={a.id}
            onPress={() => onSelect(a)}
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
  );
}

function SubscriptionsHeader({
  account, accounts, colors, counts, query, status, scanning,
  onBack, onScan, onSelectAccount, onChangeQuery, onChangeStatus,
}: Readonly<{
  account: TenantMailAccount | null;
  accounts: TenantMailAccount[];
  colors: ThemeColors;
  counts: { active: number; unsubscribed: number };
  query: string;
  status: StatusFilter;
  scanning: boolean;
  onBack: () => void;
  onScan: () => void;
  onSelectAccount: (account: TenantMailAccount) => void;
  onChangeQuery: (query: string) => void;
  onChangeStatus: (status: StatusFilter) => void;
}>) {
  return (
    <ScreenHeader
      title="Subscriptions"
      subtitle={account?.emailAddress}
      onBack={onBack}
      actions={
        <IconButton
          icon={<RefreshCw size={20} color={colors.text} />}
          accessibilityLabel="Scan mailbox"
          onPress={onScan}
          disabled={scanning || !account}
        />
      }
      below={
        <View style={styles.below}>
          {accounts.length > 1 ? (
            <AccountChips accounts={accounts} activeId={account?.id} colors={colors} onSelect={onSelectAccount} />
          ) : null}
          <SearchBar value={query} onChangeText={onChangeQuery} placeholder="Search senders" onClear={() => onChangeQuery('')} />
          <SegmentedControl
            options={[
              { label: `Subscribed (${counts.active})`, value: 'active' },
              { label: `Unsubscribed (${counts.unsubscribed})`, value: 'unsubscribed' },
            ]}
            value={status}
            onValueChange={(v) => onChangeStatus(v as StatusFilter)}
          />
        </View>
      }
    />
  );
}

function SubscriptionsEmpty({ query, status, scanning, colors, onScan }: Readonly<{
  query: string;
  status: StatusFilter;
  scanning: boolean;
  colors: ThemeColors;
  onScan: () => void;
}>) {
  const showScanHint = !query && status === 'active';
  return (
    <EmptyState
      icon={<MailX size={40} color={colors.mutedForeground} />}
      title={emptyTitle(query, status)}
      description={
        showScanHint
          ? 'Newsletters appear here as they arrive. Scan the mailbox to find the ones you already have.'
          : undefined
      }
      action={
        showScanHint ? (
          <Button title={scanning ? 'Scanning…' : 'Scan mailbox'} onPress={onScan} loading={scanning} />
        ) : undefined
      }
    />
  );
}

function UnsubscribeConfirm({ pending, unsubscribing, onConfirm, onCancel }: Readonly<{
  pending: TenantSubscription | null;
  unsubscribing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  return (
    <ConfirmModal
      visible={!!pending}
      title={pending ? `Unsubscribe from ${senderLabel(pending)}?` : ''}
      message={pending ? confirmMessage(pending) : undefined}
      confirmText={pending && isLinkOnlySubscription(pending) ? 'Open page' : 'Unsubscribe'}
      variant="destructive"
      loading={unsubscribing}
      onConfirm={onConfirm}
      onCancel={() => !unsubscribing && onCancel()}
    />
  );
}

function SubscriptionsBody({ loading, loadError, visible, refreshing, scanning, query, status, colors, onRetry, onRefresh, onScan, onUnsubscribe }: Readonly<{
  loading: boolean;
  loadError: boolean;
  visible: TenantSubscription[];
  refreshing: boolean;
  scanning: boolean;
  query: string;
  status: StatusFilter;
  colors: ThemeColors;
  onRetry: () => void;
  onRefresh: () => void;
  onScan: () => void;
  onUnsubscribe: (item: TenantSubscription) => void;
}>) {
  if (loading) return <ListSkeleton count={8} />;
  if (loadError) return <ErrorState message="Could not load subscriptions" onRetry={onRetry} />;
  return (
    <FlatList
      data={visible}
      keyExtractor={(s) => s.id}
      renderItem={({ item }) => <SubscriptionRow item={item} colors={colors} onUnsubscribe={onUnsubscribe} />}
      contentContainerStyle={visible.length === 0 ? styles.emptyContainer : undefined}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListEmptyComponent={
        <SubscriptionsEmpty query={query} status={status} scanning={scanning} colors={colors} onScan={onScan} />
      }
    />
  );
}

export default function SubscriptionsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const { accounts, selectedAccount } = useMail();

  const [account, setAccount] = useActiveAccount(accounts, selectedAccount);
  const { items, setItems, loading, setLoading, refreshing, setRefreshing, loadError, load } = useSubscriptionList(account);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<TenantSubscription | null>(null);
  const [unsubscribing, setUnsubscribing] = useState(false);

  const visible = useMemo(() => filterSubscriptions(items, status, query), [items, status, query]);
  const counts = useMemo(() => countByStatus(items), [items]);

  const handleScan = async () => {
    if (!account || scanning) return;
    setScanning(true);
    await performScan(account, toast, load);
    setScanning(false);
  };

  const handleUnsubscribe = async () => {
    if (!account || !pending) return;
    setUnsubscribing(true);
    await performUnsubscribe(account, pending, toast, setItems);
    setUnsubscribing(false);
    setPending(null);
  };

  const header = (
    <SubscriptionsHeader
      account={account}
      accounts={accounts}
      colors={colors}
      counts={counts}
      query={query}
      status={status}
      scanning={scanning}
      onBack={() => router.back()}
      onScan={handleScan}
      onSelectAccount={setAccount}
      onChangeQuery={setQuery}
      onChangeStatus={setStatus}
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
      <SubscriptionsBody
        loading={loading}
        loadError={loadError}
        visible={visible}
        refreshing={refreshing}
        scanning={scanning}
        query={query}
        status={status}
        colors={colors}
        onRetry={() => { setLoading(true); void load(); }}
        onRefresh={() => { setRefreshing(true); void load(); }}
        onScan={handleScan}
        onUnsubscribe={setPending}
      />

      <UnsubscribeConfirm
        pending={pending}
        unsubscribing={unsubscribing}
        onConfirm={handleUnsubscribe}
        onCancel={() => setPending(null)}
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
