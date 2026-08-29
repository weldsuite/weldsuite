import { styles } from './index.styles';
import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import {
  SectionList,
  TouchableOpacity,
  View,
  Text,
  Animated,
  RefreshControl,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  AppState,
} from 'react-native';
import { useObserve } from 'expo-observe';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import {
  Star, Paperclip, PenLine, Menu, Search, File,
  Trash2, Archive, Clock, Calendar, Clock4,
  MailOpen, Pin, Inbox, SendHorizontal, Mail,
} from 'lucide-react-native';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { appApi } from '@/services/app-api';
import { isNetworkError } from '@weldsuite/api-client/client';
import { useMailCache } from '@/hooks/useMailCache';
import { useMailOutbox } from '@/hooks/useMailOutbox';
import { useMail, getAvatarColor } from '@/contexts/MailContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { usePinnedMessages } from '@/contexts/PinnedMessagesContext';
import { useComposeOverlay } from '@/contexts/ComposeOverlayContext';
import type { ComposeCloseInfo } from '@/app/compose';
import LabelDrawer from '@/components/LabelDrawer';
import LabelPanel from '@/components/LabelPanel';
import AccountMiniSidebar from '@/components/AccountMiniSidebar';
import SnoozePickerModal from '@/components/SnoozePickerModal';
import EmailDetailPanel from '@/components/EmailDetailPanel';
import { Screen, ScreenHeader } from '@/components/screen';
import { ListSkeleton } from '@/components/data-states';
import { filterDisplayLabels, getLabelColor } from '@/utils/label-utils';
import { useIsTablet } from '@/utils/tablet';
import { ACCENTS, BRAND, BRAND_TINT, tint } from '@/lib/brand';
import type { EmailListItem } from '@/types/mail';
import {
  listContainsEmailId,
  nextNotificationListRetryMs,
} from '@/utils/notification-target';
import { hideAppSplash } from '@/utils/splash';

const EMAIL_LIST_WIDTH_TABLET = 400;

// Matches the platform row format: `format(date, 'h:mm a')` → "3:42 PM"
function formatRowTime(input?: string): string {
  if (!input) return '';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// Swipeable Email Item Component
const SwipeableEmailItem = memo(({ item, onPress, onDelete, onArchive, onSnooze, onToggleRead, onPin, pinned, colors, isSelected, labelColorMap, isTablet, isDark }: {
  item: EmailListItem;
  onPress: (email: EmailListItem) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onSnooze: (id: string) => void;
  onToggleRead: (id: string, isRead: boolean) => void;
  onPin: (id: string) => void;
  pinned?: boolean;
  colors: any;
  isSelected?: boolean;
  labelColorMap?: Record<string, string>;
  isTablet?: boolean;
  isDark?: boolean;
}) => {
  const senderName = item.from?.name || item.from?.email || item.fromName || 'Unknown';
  const avatarColor = getAvatarColor(senderName);
  const swipeableRef = useRef<Swipeable>(null);

  const swipeIconSize = isTablet ? 24 : 20;
  const swipeActionStyle = isTablet ? [styles.swipeAction, { width: 90 }] : [styles.swipeAction];

  const renderLeftActions = () => (
    <View style={styles.swipeActionsContainer}>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: ACCENTS.unread }]}
        onPress={() => { onToggleRead(item.id, !!item.isRead); swipeableRef.current?.close(); }}
      >
        <MailOpen size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>{item.isRead ? 'Unread' : 'Read'}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: ACCENTS.pin }]}
        onPress={() => { onPin(item.id); swipeableRef.current?.close(); }}
      >
        <Pin size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>{pinned ? 'Unpin' : 'Pin'}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderRightActions = () => (
    <View style={styles.swipeActionsContainer}>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: ACCENTS.snooze }]}
        onPress={() => { onSnooze(item.id); swipeableRef.current?.close(); }}
      >
        <Clock size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>Snooze</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: ACCENTS.archive }]}
        onPress={() => { onArchive(item.id); swipeableRef.current?.close(); }}
      >
        <Archive size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>Archive</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: ACCENTS.delete }]}
        onPress={() => { onDelete(item.id); swipeableRef.current?.close(); }}
      >
        <Trash2 size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      overshootLeft={false}
      overshootRight={false}
      friction={1.5}
      leftThreshold={30}
      rightThreshold={30}
      enableTrackpadTwoFingerGesture
    >
      <TouchableOpacity
        onPress={() => onPress(item)}
        activeOpacity={0.7}
        delayPressIn={50}
        style={[
          styles.emailItem,
          {
            backgroundColor: isSelected ? BRAND_TINT : colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View style={[styles.emailRow, isTablet && { paddingHorizontal: 20, paddingVertical: 14, gap: 14 }]}>
          <View style={styles.avatarWrap}>
            <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.avatarText}>
                {senderName.charAt(0).toUpperCase()}
              </Text>
            </View>
            {!item.isRead && !isSelected && (
              <View style={[styles.unreadDot, { backgroundColor: BRAND }]} />
            )}
          </View>

          <View style={styles.emailContent}>
            <View style={styles.emailTop}>
              <View style={styles.senderRow}>
                <Text
                  style={[
                    styles.senderName,
                    {
                      color: item.isRead ? colors.mutedForeground : colors.text,
                      fontWeight: item.isRead ? '500' : '600',
                    },
                  ]}
                  numberOfLines={1}
                >
                  {senderName || 'Unknown'}
                </Text>
                {item.threadCount != null && item.threadCount > 1 && (
                  <View style={[styles.threadCountBadge, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Text style={[styles.threadCountText, { color: colors.mutedForeground }]}>{item.threadCount}</Text>
                  </View>
                )}
              </View>
              <View style={styles.emailMeta}>
                {item.hasAttachments && (
                  <Paperclip size={12} color={colors.muted} strokeWidth={2} />
                )}
                {pinned && (
                  <Pin size={12} color={ACCENTS.pin} fill={ACCENTS.pin} strokeWidth={2} />
                )}
                {item.isStarred && (
                  <Star size={12} color={ACCENTS.star} fill={ACCENTS.star} strokeWidth={2} style={{ marginTop: -1.5 }} />
                )}
                <Text style={[styles.emailTime, { color: colors.muted }]}>
                  {formatRowTime(item.receivedDate || item.createdAt)}
                </Text>
              </View>
            </View>

            <Text
              style={[
                styles.subject,
                {
                  color: item.isRead ? colors.mutedForeground : colors.text,
                  fontWeight: item.isRead ? '400' : '500',
                },
              ]}
              numberOfLines={1}
            >
              {item.subject || '(No subject)'}
            </Text>

            <Text
              style={[styles.preview, { color: colors.mutedForeground }]}
              numberOfLines={1}
            >
              {item.preview || item.snippet || ''}
            </Text>

            {(() => {
              const displayLabels = filterDisplayLabels(item.labels || []);
              if (displayLabels.length === 0) return null;
              return (
                <View style={styles.labelBadgeRow}>
                  {displayLabels.slice(0, 3).map((labelName) => {
                    const color = getLabelColor(labelName, labelColorMap);
                    return (
                      <View key={labelName} style={[styles.labelBadge, { backgroundColor: tint(color) }]}>
                        <Text style={[styles.labelBadgeText, { color }]}>{labelName}</Text>
                      </View>
                    );
                  })}
                  {displayLabels.length > 3 && (
                    <Text style={[styles.labelOverflow, { color: colors.muted }]}>
                      +{displayLabels.length - 3}
                    </Text>
                  )}
                </View>
              );
            })()}

            {(item.unreadCount ?? 0) > 0 && (item.threadCount ?? 0) > 1 && (
              <View style={[styles.labelBadge, { alignSelf: 'flex-start', marginTop: 6, backgroundColor: BRAND_TINT }]}>
                <Text style={[styles.labelBadgeText, { color: BRAND }]}>{item.unreadCount} unread</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
});

SwipeableEmailItem.displayName = 'SwipeableEmailItem';

export default function MailScreen() {
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const router = useRouter();
  const { markInteractive } = useObserve();
  const params = useLocalSearchParams<{ draftSaved?: string; draftId?: string; draftAccountId?: string; draftTo?: string; draftCc?: string; draftBcc?: string; draftSubject?: string; draftBody?: string }>();
  const insets = useSafeAreaInsets();
  const { width: _windowWidth } = useWindowDimensions();
  const {
    selectedLabel,
    labels,
    customLabels,
    selectedAccount,
    isUnifiedInbox,
    accounts,
    updateLabelCount,
    mailVersion,
    pendingNotificationEmailId,
    clearPendingNotificationEmail,
  } = useMail();
  const { launchReady } = useNotifications();
  const cache = useMailCache();
  const outbox = useMailOutbox();
  const { organizationId } = useClerkAuth();

  // The mailbox + label the user is currently viewing, as one stable key.
  // Each key is an isolated list: switching account or opening the unified
  // inbox swaps to a different scope and we never let one scope's messages
  // bleed into another. 'unified' is its own scope that already aggregates
  // every account server-side.
  const scopeId = cache.scopeKey(isUnifiedInbox, selectedAccount?.id);
  const currentScope = `${scopeId}::${selectedLabel}`;
  // Scope the latest fetch was fired for — a response is dropped if the user
  // switched mailbox while it was in flight (kills the appear/disappear flicker).
  const activeScopeRef = useRef(currentScope);
  // Per-scope in-memory snapshot of the last list shown, so switching between
  // already-visited mailboxes repaints instantly with no blank flash.
  const scopeSnapshots = useRef<Map<string, EmailListItem[]>>(new Map());
  const isTablet = useIsTablet();
  const { openCompose } = useComposeOverlay();
  const { isPinned: isMessagePinned, togglePin } = usePinnedMessages();

  const labelColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    customLabels.forEach(l => { if (l.color) map[l.name] = l.color; });
    return map;
  }, [customLabels]);

  const [messages, setMessages] = useState<EmailListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [labelPanelVisible, setLabelPanelVisible] = useState(false);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const snackbarTranslateY = useRef(new Animated.Value(60)).current;
  const snackbarTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Opacity for the message list, cross-faded on every mailbox/label switch.
  const listOpacity = useRef(new Animated.Value(1)).current;

  type FilterKey = 'all' | 'unread' | 'starred' | 'attachments';
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const filterChips: { key: FilterKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'starred', label: 'Starred' },
    { key: 'attachments', label: 'Attachments' },
  ];

  // Snooze state
  const [snoozePickerVisible, setSnoozePickerVisible] = useState(false);
  const [snoozeTargetId, setSnoozeTargetId] = useState<string | null>(null);
  const snoozedMessageRef = useRef<any>(null);

  // Draft undo/discard state
  const lastDraftIdRef = useRef<string | null>(null);
  const lastDraftDataRef = useRef<any>(null);

  const currentLabelName = labels.find((l) => l.slug === selectedLabel)?.name || selectedLabel;

  const fetchMessages = useCallback(async (search?: string) => {
    // Capture the scope this request is for; if the user switches mailbox
    // before it resolves we throw the result away instead of flashing it into
    // the wrong list.
    const requestScope = activeScopeRef.current;
    try {
      const queryParams: Record<string, any> = { label: selectedLabel, limit: 50 };
      if (!isUnifiedInbox && selectedAccount?.id) queryParams.accountId = selectedAccount.id;
      if (search) queryParams.search = search;
      const { data: list } = await appApi.mailMessages.list(queryParams);
      if (activeScopeRef.current !== requestScope) return;
      // Enrich with thread count
      const threadCounts: Record<string, number> = {};
      list.forEach((m) => {
        if (m.threadId) threadCounts[m.threadId] = (threadCounts[m.threadId] || 0) + 1;
      });
      const enriched = list.map((m) => ({
        ...m,
        threadCount: m.threadId ? (threadCounts[m.threadId] || 1) : 1,
      }));
      // Fold any not-yet-synced mutations (offline star/delete/archive/…) onto
      // the fresh server data so the list doesn't briefly revert pending changes.
      const overlaid = await outbox.overlay(enriched, selectedLabel);
      if (activeScopeRef.current !== requestScope) return;
      setMessages(overlaid);
      const unreadCount = list.filter((m) => !m.isRead).length;
      updateLabelCount(selectedLabel, unreadCount);
      // Persist the raw (un-overlaid) server result so the cache stays "last
      // known server truth"; the overlay is re-applied on every read instead.
      if (!search) {
        cache.setMessages(scopeId, selectedLabel, enriched);
      }
    } catch (error) {
      // Offline / dropped connection: keep whatever is already on screen
      // (cached or previously-loaded) rather than clearing to an empty list.
      // Only real (server) errors are worth logging.
      if (!isNetworkError(error)) console.error('Failed to fetch messages:', error);
    } finally {
      // Only the request that still owns the screen may clear the spinner.
      if (activeScopeRef.current === requestScope) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [selectedLabel, selectedAccount?.id, isUnifiedInbox, scopeId, cache, outbox, updateLabelCount]);

  // Always call the latest fetchMessages from effects/refs without re-subscribing.
  const fetchMessagesRef = useRef(fetchMessages);
  fetchMessagesRef.current = fetchMessages;

  useEffect(() => {
    activeScopeRef.current = currentScope;
    let cancelled = false;
    setSelectedEmailId(null);

    // Instant, isolated repaint. Show this scope's last-known list from the
    // in-memory snapshot if we have one; otherwise clear right away so the
    // previous mailbox's messages are never shown under the new one.
    const snapshot = scopeSnapshots.current.get(currentScope);
    if (snapshot) {
      setMessages(snapshot);
      setLoading(false);
    } else {
      setMessages([]);
      setLoading(true);
    }

    (async () => {
      // Second-chance paint from the persistent cache for scopes not yet
      // visited this session (cold start / previous run). Guarded so a slow
      // read can't land after another switch.
      if (!snapshot) {
        const cached = await cache.getMessages(scopeId, selectedLabel);
        if (!cancelled && activeScopeRef.current === currentScope && cached && cached.length) {
          const overlaid = await outbox.overlay(cached as EmailListItem[], selectedLabel);
          if (!cancelled && activeScopeRef.current === currentScope) {
            setMessages(overlaid);
            setLoading(false);
          }
        }
      }
      if (!cancelled) fetchMessagesRef.current();
    })();

    // Fetch draft count
    const fetchDraftCount = async () => {
      try {
        const accountId = !isUnifiedInbox && selectedAccount?.id ? selectedAccount.id : undefined;
        const { data: drafts } = await appApi.mailDrafts.list(accountId ? { accountId } : {});
        if (drafts.length > 0) updateLabelCount('DRAFTS', drafts.length);
      } catch {}
    };
    fetchDraftCount();

    return () => {
      cancelled = true;
    };
    // Re-run when the selected mailbox/label changes, or when the account list
    // first loads. On a cold start the very first fetch fires in unified mode
    // before fetchAccounts() resolves and can lose the race against Clerk's
    // org-scoped token (the same 403 ORG_REQUIRED race fetchAccounts retries
    // through); in unified mode the scope key doesn't change, so accounts.length
    // flipping 0 → N is the reliable retry signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScope, accounts.length]);

  // Keep the active scope's in-memory snapshot in lockstep with what's on
  // screen, so optimistic changes (star/archive/delete/read) survive a
  // switch-away-and-back without a re-fetch flash.
  useEffect(() => {
    scopeSnapshots.current.set(activeScopeRef.current, messages);
  }, [messages]);

  // Cross-fade the list on every mailbox/label switch, and when an uncached
  // mailbox's first page finishes loading (loading → false). Pull-to-refresh
  // and background re-syncs touch neither dep, so they don't re-fade.
  useEffect(() => {
    listOpacity.setValue(0);
    const anim = Animated.timing(listOpacity, {
      toValue: 1,
      duration: 150,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [currentScope, loading, listOpacity]);

  // Silently re-sync the inbox whenever a mutation happens elsewhere (e.g. the
  // detail page starring/archiving/snoozing). mailVersion is bumped via
  // refreshMail(); fetchMessagesRef (defined above) always points at the latest
  // fetchMessages so we don't re-subscribe on every label/account change.
  useEffect(() => {
    if (mailVersion === 0) return; // skip the initial render
    fetchMessagesRef.current();
  }, [mailVersion]);

  // Revalidate whenever the inbox regains focus. Realtime `mail:new` is the
  // happy path, but on mobile the socket is suspended in the background and
  // routinely drops events, so without a focus refetch the list can sit on a
  // stale cached snapshot indefinitely — showing no new mail and holding rows
  // that 404 when tapped. Re-fetching on focus is the reliable backstop.
  useFocusEffect(
    useCallback(() => {
      fetchMessagesRef.current();
    }, []),
  );

  // Same reasoning across an app background→foreground cycle: the socket is
  // almost always stale on resume, so pull a fresh page as soon as we're active.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') fetchMessagesRef.current();
    });
    return () => sub.remove();
  }, []);

  // Self-heal the org-scoping race. The first message fetch can fire before
  // Clerk's session token carries the active org (app-api answers 403
  // ORG_REQUIRED) and fetchMessages has no retry of its own, so it would
  // otherwise stay stuck on the cached list for the whole session. Re-fetch
  // once the org id resolves so the mailbox self-corrects without a
  // clear-data + re-login.
  useEffect(() => {
    if (organizationId) fetchMessagesRef.current();
  }, [organizationId]);

  // A notification tap can open the app before the new message is in the
  // inbox list (stale cache, or the list fetch raced the insert). Keep
  // re-fetching with a short backoff until the row appears or we give up.
  useEffect(() => {
    if (
      pendingNotificationEmailId &&
      listContainsEmailId(messages, pendingNotificationEmailId)
    ) {
      clearPendingNotificationEmail();
    }
  }, [pendingNotificationEmailId, messages, clearPendingNotificationEmail]);

  useEffect(() => {
    if (!pendingNotificationEmailId) return;
    let cancelled = false;
    let attempt = 0;

    const tick = async () => {
      while (!cancelled) {
        const delay = nextNotificationListRetryMs(attempt);
        if (delay == null) {
          if (!cancelled) clearPendingNotificationEmail();
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (cancelled) return;
        attempt += 1;
        await fetchMessagesRef.current();
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [pendingNotificationEmailId, clearPendingNotificationEmail]);

  useEffect(() => {
    if (launchReady) {
      hideAppSplash();
      markInteractive();
    }
  }, [launchReady, markInteractive]);


  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    fetchMessages();
  }, [refreshing, fetchMessages]);

  const handleEmailPress = useCallback((email: EmailListItem) => {
    // Opening an email marks it read on the server (see app/[id].tsx), so
    // reflect that in the list immediately — whether we open it inline (tablet)
    // or navigate to the detail screen (phone). The index screen stays mounted
    // while the detail is pushed, so this optimistic update is exactly what the
    // user sees on return; without it the row stayed bold-unread until the next
    // full refresh. The next background sync confirms it against the server.
    if (!email.isRead) {
      setMessages(prev => prev.map(m => m.id === email.id ? { ...m, isRead: true } : m));
    }
    if (isTablet) {
      setSelectedEmailId(email.id);
    } else {
      router.push(`/${email.id}` as any);
    }
  }, [router, isTablet]);

  const handleDelete = useCallback(async (emailId: string) => {
    // Optimistically drop from the list; the outbox replays the delete on
    // reconnect, and the pending overlay keeps it hidden until then.
    setMessages(prev => prev.filter(m => m.id !== emailId));
    await outbox.remove(emailId);
  }, [outbox]);

  const handleArchive = useCallback(async (emailId: string) => {
    setMessages(prev => prev.filter(m => m.id !== emailId));
    await outbox.archive(emailId);
  }, [outbox]);

  const handleSnooze = useCallback((emailId: string) => {
    setSnoozeTargetId(emailId);
    setSnoozePickerVisible(true);
  }, []);

  const showSnackbar = useCallback((text: string, duration = 3000) => {
    if (snackbarTimerRef.current) clearTimeout(snackbarTimerRef.current);
    setSnackbar(text);
    snackbarTranslateY.setValue(60);
    Animated.spring(snackbarTranslateY, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 300 }).start();
    snackbarTimerRef.current = setTimeout(() => {
      Animated.timing(snackbarTranslateY, { toValue: 60, duration: 250, useNativeDriver: true }).start(() =>
        setSnackbar(null),
      );
    }, duration);
  }, [snackbarTranslateY]);

  const dismissSnackbar = useCallback(() => {
    if (snackbarTimerRef.current) clearTimeout(snackbarTimerRef.current);
    Animated.timing(snackbarTranslateY, { toValue: 60, duration: 200, useNativeDriver: true }).start(() =>
      setSnackbar(null),
    );
  }, [snackbarTranslateY]);

  // Show snackbar when returning from compose with draft saved
  useEffect(() => {
    if (params.draftSaved === '1') {
      // Cache draft info for undo/discard
      if (params.draftId) {
        lastDraftIdRef.current = params.draftId;
        lastDraftDataRef.current = {
          emailAccountId: params.draftAccountId || '',
          to: params.draftTo || '',
          cc: params.draftCc || '',
          bcc: params.draftBcc || '',
          subject: params.draftSubject || '',
          body: params.draftBody || '',
        };
      }
      router.setParams({ draftSaved: undefined, draftId: undefined, draftAccountId: undefined, draftTo: undefined, draftCc: undefined, draftBcc: undefined, draftSubject: undefined, draftBody: undefined } as any);

      showSnackbar('Draft saved');
    }
  }, [
    params.draftSaved,
    params.draftId,
    params.draftAccountId,
    params.draftTo,
    params.draftCc,
    params.draftBcc,
    params.draftSubject,
    params.draftBody,
    router,
    showSnackbar,
  ]);

  // Handle the compose overlay closing — caches the saved draft for undo and
  // surfaces the "Draft saved" snackbar (replaces the old route-param flow).
  const handleComposeClose = useCallback((info?: ComposeCloseInfo) => {
    if (!info?.draftSaved) return;
    const draftData = {
      emailAccountId: info.draftAccountId || '',
      to: info.draftTo || '',
      cc: info.draftCc || '',
      bcc: info.draftBcc || '',
      subject: info.draftSubject || '',
      body: info.draftBody || '',
    };
    lastDraftDataRef.current = draftData;
    lastDraftIdRef.current = info.draftId || null;
    showSnackbar('Draft saved');
    // The compose sheet closed instantly without waiting on the network, so
    // persist the draft here in the background and capture its id (used by the
    // snackbar's Discard action to delete the draft).
    if (!info.draftId && draftData.emailAccountId) {
      appApi.mailDrafts.create({
        accountId: draftData.emailAccountId,
        to: draftData.to ? draftData.to.split(/[,;]\s*/).map(s => s.trim()).filter(Boolean) : undefined,
        cc: draftData.cc ? draftData.cc.split(/[,;]\s*/).map(s => s.trim()).filter(Boolean) : undefined,
        bcc: draftData.bcc ? draftData.bcc.split(/[,;]\s*/).map(s => s.trim()).filter(Boolean) : undefined,
        subject: draftData.subject || undefined,
        body: draftData.body || undefined,
      })
        .then((res) => {
          lastDraftIdRef.current = res.data.id;
        })
        .catch(() => {});
    }
  }, [showSnackbar]);

  const handleOpenCompose = useCallback(() => {
    openCompose(undefined, { onClose: handleComposeClose });
  }, [openCompose, handleComposeClose]);

  const handleSnoozeSelect = useCallback(async (until: string, label: string) => {
    setSnoozePickerVisible(false);
    if (!snoozeTargetId) return;

    const emailId = snoozeTargetId;
    const snoozedMsg = messages.find(m => m.id === emailId);
    snoozedMessageRef.current = snoozedMsg;
    setMessages(prev => prev.filter(m => m.id !== emailId));

    const accountId = (snoozedMsg as any)?.accountId || '';
    await outbox.snooze(emailId, accountId, until);
    showSnackbar(`Snoozed — ${label.toLowerCase()}`, 4000);
    setSnoozeTargetId(null);
  }, [snoozeTargetId, messages, showSnackbar, outbox]);

  const handleSnoozeUndo = useCallback(async () => {
    const msg = snoozedMessageRef.current;
    if (!msg) return;
    dismissSnackbar();
    const accountId = (msg as any)?.accountId || '';
    await outbox.unsnooze(msg.id, accountId);
    setMessages(prev => [msg, ...prev]);
    snoozedMessageRef.current = null;
  }, [dismissSnackbar, outbox]);

  const handleDetailEmailDeleted = useCallback((emailId: string) => {
    setMessages(prev => prev.filter(m => m.id !== emailId));
    setSelectedEmailId(null);
  }, []);

  const handleDetailEmailArchived = useCallback((emailId: string) => {
    setMessages(prev => prev.filter(m => m.id !== emailId));
    setSelectedEmailId(null);
  }, []);

  const handleToggleRead = useCallback(async (emailId: string, isRead: boolean) => {
    setMessages(prev => prev.map(m => m.id === emailId ? { ...m, isRead: !isRead } : m));
    await outbox.update(emailId, { isRead: !isRead });
  }, [outbox]);

  // Pin is client-side only (no backend field) — store it in the shared
  // PinnedMessages context so the inbox and the detail page stay in sync.
  const handlePin = useCallback((emailId: string) => {
    togglePin(emailId);
  }, [togglePin]);


  const getDateSection = (item: EmailListItem) => {
    const dateStr = item.receivedDate || item.createdAt;
    if (!dateStr) return 'Older';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 'Older';
    // Compare calendar days in the device's local timezone, not elapsed
    // milliseconds. Using raw elapsed time would label an email from
    // yesterday evening as "Today" when viewed early the next morning
    // (< 24h old). Zeroing the time-of-day pins each date to its local day.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfDate = new Date(date);
    startOfDate.setHours(0, 0, 0, 0);
    const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays <= 7) return 'This Week';
    return 'Older';
  };

  const groupEmailsByDate = useCallback((emails: EmailListItem[]) => {
    const pinned: EmailListItem[] = [];
    const unpinned: EmailListItem[] = [];
    emails.forEach(email => {
      if (isMessagePinned(email.id)) pinned.push(email);
      else unpinned.push(email);
    });

    const sections: { [key: string]: EmailListItem[] } = {};
    unpinned.forEach(email => {
      const section = getDateSection(email);
      if (!sections[section]) sections[section] = [];
      sections[section].push(email);
    });

    const order = ['Today', 'Yesterday', 'This Week', 'Older'];
    const dateSections = order
      .filter(title => sections[title]?.length > 0)
      .map(title => ({ title, data: sections[title] }));

    return pinned.length > 0
      ? [{ title: 'Pinned', data: pinned }, ...dateSections]
      : dateSections;
  }, [isMessagePinned]);

  const filteredMessages = useMemo(() => {
    if (activeFilter === 'all') return messages;
    return messages.filter((m: EmailListItem) => {
      if (activeFilter === 'unread') return !m.isRead;
      if (activeFilter === 'starred') {
        return m.isStarred || (Array.isArray(m.labels) && m.labels.includes('STARRED'));
      }
      if (activeFilter === 'attachments') return !!m.hasAttachments;
      return true;
    });
  }, [messages, activeFilter]);

  const emailSections = useMemo(
    () => groupEmailsByDate(filteredMessages),
    [groupEmailsByDate, filteredMessages],
  );

  const renderSectionHeader = ({ section }: { section: { title: string } }) => (
    <View style={[styles.sectionHeader, { backgroundColor: colors.background }]}>
      <Text style={[styles.sectionHeaderText, { color: colors.mutedForeground }]}>{section.title}</Text>
    </View>
  );

  const renderEmail = useCallback(({ item }: { item: EmailListItem }) => (
    <SwipeableEmailItem
      item={item}
      onPress={handleEmailPress}
      onDelete={handleDelete}
      onArchive={handleArchive}
      onSnooze={handleSnooze}
      onToggleRead={handleToggleRead}
      onPin={handlePin}
      pinned={isMessagePinned(item.id)}
      colors={colors}
      labelColorMap={labelColorMap}
      isTablet={isTablet}
      isSelected={isTablet && selectedEmailId === item.id}
      isDark={isDark}
    />
  ), [
    handleEmailPress, handleDelete, handleArchive, handleSnooze, handleToggleRead, handlePin,
    isMessagePinned, colors, labelColorMap, isTablet, selectedEmailId, isDark,
  ]);

  const emptyStateContent: Record<string, { title: string; description: string; icon: React.ReactNode }> = useMemo(() => {
    const muted = colors.muted;
    return {
      INBOX: { title: 'No emails yet', description: 'Your inbox is empty', icon: <Inbox size={40} color={muted} strokeWidth={1.5} /> },
      SENT: { title: 'No sent emails', description: 'Messages you send appear here', icon: <SendHorizontal size={40} color={muted} strokeWidth={1.5} /> },
      DRAFTS: { title: 'No drafts', description: 'Unfinished emails appear here', icon: <File size={40} color={muted} strokeWidth={1.5} /> },
      STARRED: { title: 'No starred emails', description: 'Star emails to find them here', icon: <Star size={40} color={muted} strokeWidth={1.5} /> },
      TRASH: { title: 'Trash is empty', description: 'Deleted emails end up here', icon: <Trash2 size={40} color={muted} strokeWidth={1.5} /> },
      SPAM: { title: 'No spam', description: 'Hooray, no junk mail', icon: <Mail size={40} color={muted} strokeWidth={1.5} /> },
      ARCHIVE: { title: 'No archived emails', description: 'Archived emails appear here', icon: <Archive size={40} color={muted} strokeWidth={1.5} /> },
      ALL: { title: 'No emails', description: 'Nothing in this mailbox yet', icon: <Mail size={40} color={muted} strokeWidth={1.5} /> },
      SNOOZED: { title: 'No snoozed emails', description: 'Snoozed emails reappear later', icon: <Clock4 size={40} color={muted} strokeWidth={1.5} /> },
      SCHEDULED: { title: 'No scheduled emails', description: 'Scheduled sends appear here', icon: <Calendar size={40} color={muted} strokeWidth={1.5} /> },
      IMPORTANT: { title: 'Nothing important', description: 'Important emails appear here', icon: <Mail size={40} color={muted} strokeWidth={1.5} /> },
    };
  }, [colors.muted]);

  const renderEmptyState = () => {
    const content = emptyStateContent[selectedLabel] || {
      title: 'No emails',
      description: 'Nothing here yet',
      icon: emptyStateContent.INBOX.icon,
    };
    return (
      <View style={styles.emptyContainer}>
        <EmptyState icon={content.icon} title={content.title} description={content.description} />
      </View>
    );
  };

  const openLabels = () => {
    if (isTablet) setLabelPanelVisible(prev => !prev);
    else setDrawerVisible(true);
  };

  const listHeader = (
    <View style={[styles.listControls, { backgroundColor: colors.background, paddingHorizontal: 16, paddingTop: 8 }]}>
      <Pressable
        onPress={() => router.push('/search')}
        accessibilityRole="button"
        accessibilityLabel="Search mail"
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            height: 40,
            borderRadius: 12,
            paddingHorizontal: 12,
            gap: 10,
            backgroundColor: colors.inputBackground,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Search size={18} color={colors.placeholder} strokeWidth={2.2} />
        <Text style={{ flex: 1, fontSize: 15, color: colors.placeholder }}>Search</Text>
      </Pressable>
      <View style={styles.chipsRow}>
        {filterChips.map(chip => (
          <Chip
            key={chip.key}
            label={chip.label}
            selected={activeFilter === chip.key}
            onPress={() => setActiveFilter(chip.key)}
          />
        ))}
      </View>
    </View>
  );

  const header = (
    <ScreenHeader
      title={currentLabelName}
      leading={
        <IconButton
          icon={<Menu size={22} color={colors.text} strokeWidth={2.2} />}
          accessibilityLabel="Open labels"
          onPress={openLabels}
        />
      }
      actions={
        <>
          <IconButton
            icon={<PenLine size={20} color={colors.text} strokeWidth={2.2} />}
            accessibilityLabel="Compose"
            onPress={handleOpenCompose}
          />
          <IconButton
            icon={
              <View style={[styles.headerAvatar, { backgroundColor: selectedAccount ? getAvatarColor(selectedAccount.displayName) : colors.muted }]}>
                <Text style={styles.headerAvatarText}>
                  {selectedAccount?.displayName?.charAt(0).toUpperCase() || 'U'}
                </Text>
              </View>
            }
            accessibilityLabel="Settings"
            onPress={() => router.push('/settings' as any)}
          />
        </>
      }
    />
  );

  // Keep the first paint minimal while mail loads — the full header chrome
  // only mounts once we have a list to show (avoids a heavy tree during OTA boot).
  const emailListContent = loading ? (
    <Screen edges={isTablet ? [] : ['top']}>
      <ListSkeleton />
    </Screen>
  ) : (
    <Screen header={header} edges={isTablet ? [] : ['top']} style={styles.container}>
      <Animated.View style={[styles.listRegion, { opacity: listOpacity }]}>
        <SectionList
          sections={emailSections}
          renderItem={renderEmail}
          renderSectionHeader={renderSectionHeader}
          keyExtractor={(item) => `email-${item.id}`}
          contentContainerStyle={styles.listContainer}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={renderEmptyState}
          showsVerticalScrollIndicator={false}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={7}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={BRAND}
              colors={[BRAND]}
              progressBackgroundColor={colors.cardBackground}
            />
          }
          stickySectionHeadersEnabled={false}
        />
      </Animated.View>

      {snackbar && (
        <Animated.View style={[styles.snackbar, { bottom: insets.bottom + 8, transform: [{ translateY: snackbarTranslateY }] }]}>
          <Text style={styles.snackbarText}>{snackbar}</Text>
          {snackbar.startsWith('Snoozed') && (
            <TouchableOpacity onPress={handleSnoozeUndo} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[styles.snackbarAction, { color: BRAND }]}>Undo</Text>
            </TouchableOpacity>
          )}
          {snackbar === 'Draft discarded' && (
            <TouchableOpacity
              onPress={async () => {
                const draftData = lastDraftDataRef.current;
                if (!draftData?.emailAccountId) { dismissSnackbar(); return; }
                dismissSnackbar();
                try {
                  const res = await appApi.mailDrafts.create({
                    accountId: draftData.emailAccountId,
                    to: draftData.to ? draftData.to.split(/[,;]\s*/).map((s: string) => s.trim()).filter(Boolean) : undefined,
                    cc: draftData.cc ? draftData.cc.split(/[,;]\s*/).map((s: string) => s.trim()).filter(Boolean) : undefined,
                    bcc: draftData.bcc ? draftData.bcc.split(/[,;]\s*/).map((s: string) => s.trim()).filter(Boolean) : undefined,
                    subject: draftData.subject || undefined,
                    body: draftData.body || undefined,
                  });
                  lastDraftIdRef.current = res.data.id;
                  showSnackbar('Draft saved');
                } catch { showSnackbar('Draft saved'); }
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={[styles.snackbarAction, { color: BRAND }]}>Undo</Text>
            </TouchableOpacity>
          )}
          {snackbar === 'Draft saved' && (
            <TouchableOpacity
              onPress={async () => {
                const draftId = lastDraftIdRef.current;
                if (!draftId) { dismissSnackbar(); return; }
                dismissSnackbar();
                try {
                  await appApi.mailDrafts.delete(draftId);
                  lastDraftIdRef.current = null;
                  showSnackbar('Draft discarded', 2000);
                } catch { showSnackbar('Draft discarded', 2000); }
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={[styles.snackbarAction, { color: BRAND }]}>Discard</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      )}

      <SnoozePickerModal
        visible={snoozePickerVisible}
        onClose={() => { setSnoozePickerVisible(false); setSnoozeTargetId(null); }}
        onSelect={handleSnoozeSelect}
      />
    </Screen>
  );

  if (isTablet) {
    return (
      <View style={[styles.splitContainer, { backgroundColor: colors.background }]}>
        <AccountMiniSidebar />
        <LabelPanel
          visible={labelPanelVisible}
          onLabelSelected={() => setLabelPanelVisible(false)}
        />
        <View style={{ width: EMAIL_LIST_WIDTH_TABLET, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border }}>
          {emailListContent}
        </View>
        <EmailDetailPanel
          emailId={selectedEmailId}
          onEmailDeleted={handleDetailEmailDeleted}
          onEmailArchived={handleDetailEmailArchived}
        />
      </View>
    );
  }

  return (
    <>
      {emailListContent}
      <LabelDrawer visible={drawerVisible} onClose={() => setDrawerVisible(false)} />
    </>
  );
}


