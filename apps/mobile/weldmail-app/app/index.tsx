import { styles } from './index.styles';
import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import {
  StyleSheet,
  SectionList,
  TouchableOpacity,
  View,
  Text,
  TextInput,
  Animated,
  RefreshControl,
  ScrollView,
  TouchableWithoutFeedback,
  useWindowDimensions,
  ActionSheetIOS,
  Platform,
  AppState,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import {
  Star, Paperclip, Edit3, Menu, Search, Mail, Inbox, Send, FileText, File,
  Trash2, Archive, AlertCircle, ChevronDown, X, Wifi, WifiOff, Clock, Calendar, Clock4,
  MailOpen, Pin,
  SendHorizontal,
} from 'lucide-react-native';
import Svg, { Defs, Pattern as SvgPattern, Path as SvgPath, Rect as SvgRect, Circle as SvgCircle, LinearGradient, RadialGradient, Stop, Mask } from 'react-native-svg';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { formatEmailTime } from '@weldsuite/mobile-ui/utils/dateFormatter';
import appApi from '@/services/app-api';
import { isNetworkError } from '@weldsuite/api-client/client';
import { useMailCache } from '@/hooks/useMailCache';
import { useMailOutbox } from '@/hooks/useMailOutbox';
import { useMail, getAvatarColor } from '@/contexts/MailContext';
import { usePinnedMessages } from '@/contexts/PinnedMessagesContext';
import { useComposeOverlay } from '@/contexts/ComposeOverlayContext';
import type { ComposeCloseInfo } from '@/app/compose';
import LabelDrawer from '@/components/LabelDrawer';
import LabelPanel from '@/components/LabelPanel';
import AccountMiniSidebar from '@/components/AccountMiniSidebar';
import SnoozePickerModal from '@/components/SnoozePickerModal';
import EmailDetailPanel from '@/components/EmailDetailPanel';
import { filterDisplayLabels, getLabelColor } from '@/utils/label-utils';
import { useIsTablet } from '@/utils/tablet';
import MaterialSpinner from '@/components/MaterialSpinner';
import type { EmailListItem } from '@/types/mail';

const DRAWER_WIDTH = 320;
const SPLIT_VIEW_MIN_WIDTH = 768;
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
        style={[...swipeActionStyle, { backgroundColor: '#3B82F6' }]}
        onPress={() => { onToggleRead(item.id, !!item.isRead); swipeableRef.current?.close(); }}
      >
        <MailOpen size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>{item.isRead ? 'Unread' : 'Read'}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: '#8B5CF6' }]}
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
        style={[...swipeActionStyle, { backgroundColor: '#F59E0B' }]}
        onPress={() => { onSnooze(item.id); swipeableRef.current?.close(); }}
      >
        <Clock size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>Snooze</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: '#3B82F6' }]}
        onPress={() => { onArchive(item.id); swipeableRef.current?.close(); }}
      >
        <Archive size={swipeIconSize} color="#FFFFFF" />
        <Text style={[styles.swipeActionText, isTablet && { fontSize: 13 }]}>Archive</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[...swipeActionStyle, { backgroundColor: '#EF4444' }]}
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
            backgroundColor: isSelected
              ? (isDark ? '#1A2744' : '#E8F0FE')
              : colors.background,
            borderBottomColor: isDark ? '#35353B' : '#DBDEE3',
          },
        ]}
      >
        <View style={[styles.emailRow, isTablet && { paddingHorizontal: 20, paddingVertical: 14, gap: 14 }]}>
          {/* Avatar + unread dot */}
          <View style={styles.avatarWrap}>
            <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.avatarText}>
                {senderName.charAt(0).toUpperCase()}
              </Text>
            </View>
            {!item.isRead && !isSelected && (
              <View style={styles.unreadDot} />
            )}
          </View>

          {/* Content */}
          <View style={styles.emailContent}>
            {/* Top row: sender + thread badge | icons + time */}
            <View style={styles.emailTop}>
              <View style={styles.senderRow}>
                <Text
                  style={[
                    styles.senderName,
                    {
                      color: item.isRead
                        ? (isDark ? '#9CA3AF' : '#6B7280')
                        : (isDark ? '#F9FAFB' : '#111827'),
                      fontWeight: item.isRead ? '500' : '600',
                    },
                  ]}
                  numberOfLines={1}
                >
                  {senderName || 'Unknown'}
                </Text>
                {item.threadCount > 1 && (
                  <View style={[styles.threadCountBadge, isDark && { backgroundColor: '#1F2937', borderColor: '#374151' }]}>
                    <Text style={[styles.threadCountText, isDark && { color: '#9CA3AF' }]}>{item.threadCount}</Text>
                  </View>
                )}
              </View>
              <View style={styles.emailMeta}>
                {item.hasAttachments && (
                  <Paperclip size={12} color="#9CA3AF" strokeWidth={2} />
                )}
                {pinned && (
                  <Pin size={12} color="#3B82F6" fill="#3B82F6" strokeWidth={2} />
                )}
                {item.isStarred && (
                  <Star size={12} color="#EAB308" fill="#EAB308" strokeWidth={2} style={{ marginTop: -1.5 }} />
                )}
                <Text style={[styles.emailTime, { color: '#9CA3AF' }]}>
                  {formatRowTime(item.receivedDate || item.createdAt)}
                </Text>
              </View>
            </View>

            {/* Subject */}
            <Text
              style={[
                styles.subject,
                {
                  color: item.isRead
                    ? (isDark ? '#9CA3AF' : '#6B7280')
                    : (isDark ? '#F9FAFB' : '#1F2937'),
                  fontWeight: item.isRead ? '400' : '500',
                },
              ]}
              numberOfLines={1}
            >
              {item.subject || '(No subject)'}
            </Text>

            {/* Preview */}
            <Text
              style={[
                styles.preview,
                {
                  color: isDark
                    ? '#9CA3AF' /* dark: text-muted-foreground for both states */
                    : (item.isRead ? '#9CA3AF' : '#6B7280'),
                },
              ]}
              numberOfLines={1}
            >
              {item.preview || item.snippet || ''}
            </Text>

            {/* Label badges */}
            {(() => {
              const displayLabels = filterDisplayLabels(item.labels || []);
              if (displayLabels.length === 0) return null;
              return (
                <View style={styles.labelBadgeRow}>
                  {displayLabels.slice(0, 3).map((labelName) => {
                    const color = getLabelColor(labelName, labelColorMap);
                    return (
                      <View key={labelName} style={[styles.labelBadge, { backgroundColor: color + '15' }]}>
                        <Text style={[styles.labelBadgeText, { color }]}>{labelName}</Text>
                      </View>
                    );
                  })}
                  {displayLabels.length > 3 && (
                    <Text style={[styles.labelOverflow, { color: isDark ? '#6B7280' : '#9CA3AF' }]}>
                      +{displayLabels.length - 3}
                    </Text>
                  )}
                </View>
              );
            })()}

            {/* Multi-message unread pill */}
            {item.unreadCount > 0 && item.threadCount > 1 && (
              <View style={styles.unreadCountPill}>
                <Text style={styles.unreadCountPillText}>{item.unreadCount} unread</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
});

export default function MailScreen() {
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const router = useRouter();
  const params = useLocalSearchParams<{ draftSaved?: string; draftId?: string; draftAccountId?: string; draftTo?: string; draftCc?: string; draftBcc?: string; draftSubject?: string; draftBody?: string }>();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { selectedLabel, labels, customLabels, selectedAccount, isUnifiedInbox, accounts, selectAccount, updateLabelCount, mailVersion } = useMail();
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
  const fabTranslateY = useRef(new Animated.Value(0)).current;
  const snackbarTimerRef = useRef<NodeJS.Timeout>();
  // Opacity for the message list, cross-faded on every mailbox/label switch.
  const listOpacity = useRef(new Animated.Value(1)).current;

  // Filter chips (WhatsApp-style)
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
  }, [params.draftSaved]);

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
  }, [selectedLabel, selectedAccount?.id, isUnifiedInbox, scopeId, cache, outbox]);

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
    fabTranslateY.setValue(0);
    Animated.parallel([
      Animated.spring(snackbarTranslateY, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 300 }),
      Animated.spring(fabTranslateY, { toValue: -56, useNativeDriver: true, damping: 20, stiffness: 300 }),
    ]).start();
    snackbarTimerRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(snackbarTranslateY, { toValue: 60, duration: 250, useNativeDriver: true }),
        Animated.timing(fabTranslateY, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start(() => setSnackbar(null));
    }, duration);
  }, [snackbarTranslateY, fabTranslateY]);

  const dismissSnackbar = useCallback(() => {
    if (snackbarTimerRef.current) clearTimeout(snackbarTimerRef.current);
    Animated.parallel([
      Animated.timing(snackbarTranslateY, { toValue: 60, duration: 200, useNativeDriver: true }),
      Animated.timing(fabTranslateY, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setSnackbar(null));
  }, [snackbarTranslateY, fabTranslateY]);

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

  const groupEmailsByDate = (emails: EmailListItem[]) => {
    // Split pinned vs unpinned — pinned always go to the top in their own section.
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
  };

  const renderSectionHeader = ({ section }: { section: { title: string } }) => {
    return (
      <View style={[styles.sectionHeader, { backgroundColor: colors.background }]}>
        <Text style={[styles.sectionHeaderText, isDark && { color: '#9CA3AF' }]}>{section.title}</Text>
      </View>
    );
  };

  const renderEmail = ({ item }: { item: EmailListItem }) => (
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
  );

  const emptyStateContent: Record<string, { title: string; subtitle: string; icon: React.ReactNode }> = useMemo(() => ({
    INBOX: {
      title: 'No emails yet',
      subtitle: 'Your inbox is empty',
      icon: (
        <Svg width={100} height={100} viewBox="0 0 120 120" fill="none">
          <SvgRect x={20} y={35} width={80} height={55} rx={4} fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M20 90L52 65" stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M100 90L68 65" stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M20.5 38C20.5 36.3 21.8 35 23.5 35H96.5C98.2 35 99.5 36.3 99.5 38L60 64Z" fill={colors.divider} opacity={0.3} />
          <SvgPath d="M20 35L60 64L100 35" stroke={colors.divider} strokeWidth={1} fill="none" />
        </Svg>
      ),
    },
    SENT: {
      title: 'No sent emails',
      subtitle: 'Messages you send appear here',
      icon: (
        <SendHorizontal size={56} color="#D5D5D5" strokeWidth={0.5} fill="#F3F3F3" />
      ),
    },
    DRAFTS: {
      title: 'No drafts',
      subtitle: 'Unfinished emails appear here',
      icon: (
        <File size={56} color="#D5D5D5" strokeWidth={0.5} fill="#F3F3F3" />
      ),
    },
    STARRED: {
      title: 'No starred emails',
      subtitle: 'Star emails to find them here',
      icon: (
        <Star size={56} color="#D5D5D5" strokeWidth={0.5} fill="#F3F3F3" />
      ),
    },
    TRASH: {
      title: 'Trash is empty',
      subtitle: 'Deleted emails end up here',
      icon: (
        <Svg width={100} height={100} viewBox="0 0 120 120" fill="none">
          {/* Bin body */}
          <SvgPath d="M38 42L42 95H78L82 42" fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M38 42L42 95H78L82 42" fill={colors.divider} opacity={0.08} />
          {/* Lid */}
          <SvgRect x={32} y={34} width={56} height={8} rx={2} fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgRect x={32} y={34} width={56} height={8} rx={2} fill={colors.divider} opacity={0.2} />
          {/* Handle */}
          <SvgPath d="M48 34V28H72V34" stroke={colors.divider} strokeWidth={1} fill="none" />
          {/* Lines inside */}
          <SvgPath d="M50 54V84" stroke={colors.divider} strokeWidth={1} opacity={0.5} />
          <SvgPath d="M60 54V84" stroke={colors.divider} strokeWidth={1} opacity={0.5} />
          <SvgPath d="M70 54V84" stroke={colors.divider} strokeWidth={1} opacity={0.5} />
        </Svg>
      ),
    },
    SPAM: {
      title: 'No spam',
      subtitle: 'Hooray, no junk mail',
      icon: (
        <Svg width={100} height={100} viewBox="0 0 120 120" fill="none">
          {/* Shield shape */}
          <SvgPath d="M60 20L95 38V68C95 82 78 96 60 100C42 96 25 82 25 68V38Z" fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M60 20L95 38V68C95 82 78 96 60 100C42 96 25 82 25 68V38Z" fill={colors.divider} opacity={0.1} />
          {/* Checkmark */}
          <SvgPath d="M42 60L55 73L78 48" stroke={colors.divider} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </Svg>
      ),
    },
    ARCHIVE: {
      title: 'No archived emails',
      subtitle: 'Archived emails appear here',
      icon: (
        <Svg width={100} height={100} viewBox="0 0 120 120" fill="none">
          {/* Box lid */}
          <SvgRect x={22} y={28} width={76} height={18} rx={3} fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgRect x={22} y={28} width={76} height={18} rx={3} fill={colors.divider} opacity={0.2} />
          {/* Box body */}
          <SvgPath d="M28 46V90C28 92.2 29.8 94 32 94H88C90.2 94 92 92.2 92 90V46" fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M28 46V90C28 92.2 29.8 94 32 94H88C90.2 94 92 92.2 92 90V46" fill={colors.divider} opacity={0.06} />
          {/* Down arrow into box */}
          <SvgPath d="M60 55V78" stroke={colors.divider} strokeWidth={1.5} strokeLinecap="round" />
          <SvgPath d="M50 70L60 80L70 70" stroke={colors.divider} strokeWidth={1.5} strokeLinecap="round" fill="none" />
        </Svg>
      ),
    },
    SNOOZED: {
      title: 'No snoozed emails',
      subtitle: 'Snoozed emails reappear later',
      icon: (
        <View style={{ backgroundColor: '#F3F3F3', borderRadius: 999, padding: 14 }}>
          <Clock4 size={32} color="#D5D5D5" strokeWidth={1.5} />
        </View>
      ),
    },
    SCHEDULED: {
      title: 'No scheduled emails',
      subtitle: 'Scheduled sends appear here',
      icon: (
        <Calendar size={56} color="#D5D5D5" strokeWidth={0.5} fill="#F3F3F3" />
      ),
    },
    IMPORTANT: {
      title: 'Nothing important',
      subtitle: 'Important emails appear here',
      icon: (
        <Svg width={100} height={100} viewBox="0 0 120 120" fill="none">
          {/* Envelope */}
          <SvgRect x={20} y={45} width={80} height={50} rx={4} fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M20.5 48C20.5 46.3 21.8 45 23.5 45H96.5C98.2 45 99.5 46.3 99.5 48L60 72Z" fill={colors.divider} opacity={0.15} />
          <SvgPath d="M20 45L60 72L100 45" stroke={colors.divider} strokeWidth={1} fill="none" />
          {/* Bookmark/flag on top right */}
          <SvgPath d="M75 15H95V50L85 42L75 50Z" fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M75 15H95V50L85 42L75 50Z" fill={colors.divider} opacity={0.15} />
        </Svg>
      ),
    },
  }), [colors]);

  const renderEmptyState = () => {
    const content = emptyStateContent[selectedLabel] || {
      title: 'No emails',
      subtitle: 'Nothing here yet',
      icon: emptyStateContent.INBOX.icon,
    };

    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIllustrationWrapper}>
          <Svg width={220} height={155} style={StyleSheet.absoluteFill}>
            <Defs>
              <SvgPattern id="emptyGrid" width={24} height={24} patternUnits="userSpaceOnUse">
                <SvgPath d="M 24 0 L 0 0 0 24" fill="none" stroke={colors.divider} strokeWidth={0.5} strokeDasharray="3 3" />
              </SvgPattern>
              <RadialGradient id="fadeRadial" cx="50%" cy="50%" rx="50%" ry="50%">
                <Stop offset="0" stopColor="white" stopOpacity="1" />
                <Stop offset="0.65" stopColor="white" stopOpacity="1" />
                <Stop offset="1" stopColor="white" stopOpacity="0" />
              </RadialGradient>
              <Mask id="fadeMask">
                <SvgRect width="100%" height="100%" fill="url(#fadeRadial)" />
              </Mask>
            </Defs>
            <SvgRect width="100%" height="100%" fill="url(#emptyGrid)" mask="url(#fadeMask)" />
          </Svg>
          {content.icon}
        </View>
        <Text style={[styles.emptyText, { color: colors.text }]}>
          {content.title}
        </Text>
        <Text style={[styles.emptySubtext, { color: colors.muted }]}>
          {content.subtitle}
        </Text>
      </View>
    );
  };

  const emailListContent = loading ? (
    // Full-screen centered loader — matches the auth/init loader in _layout.tsx
    // so the spinner doesn't shift position between loading phases.
    <View style={[styles.container, styles.centerContainer, { backgroundColor: colors.background }]}>
      <View style={styles.loadingRow}>
        <MaterialSpinner size={20} strokeWidth={2.6} color={isDark ? '#8AB4F8' : '#4285F4'} spinning />
        <Text style={[styles.loadingTextInline, { color: colors.muted }]}>Loading emails...</Text>
      </View>
    </View>
  ) : (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Outlook-style title bar: hamburger | title | search | avatar */}
      <View style={[
        styles.outlookHeader,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + 6,
          borderBottomColor: isDark ? '#2C2C2E' : '#E5E7EB',
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
        isTablet && { paddingHorizontal: 16 },
      ]}>
        <TouchableOpacity
          onPress={() => {
            if (isTablet) {
              setLabelPanelVisible(prev => !prev);
            } else {
              setDrawerVisible(true);
            }
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.outlookHeaderIcon}
        >
          <Menu size={24} color={isDark ? '#E8EAED' : '#1F2937'} strokeWidth={2} style={{ marginTop: 1 }} />
        </TouchableOpacity>

        <Text style={[styles.outlookHeaderTitle, { color: colors.text }]} numberOfLines={1}>
          {currentLabelName}
        </Text>

        <TouchableOpacity
          onPress={() => router.push('/settings' as any)}
          activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          style={[styles.outlookHeaderAvatar, { backgroundColor: selectedAccount ? getAvatarColor(selectedAccount.displayName) : '#6B7280' }]}
        >
          <Text style={styles.outlookHeaderAvatarText}>
            {selectedAccount?.displayName?.charAt(0).toUpperCase() || 'U'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Email List */}
      <Animated.View style={[styles.listRegion, { opacity: listOpacity }]}>
        <SectionList
          sections={groupEmailsByDate(
            activeFilter === 'all'
              ? messages
              : messages.filter((m: EmailListItem) => {
                  if (activeFilter === 'unread') return !m.isRead;
                  if (activeFilter === 'starred') {
                    return m.isStarred || (Array.isArray(m.labels) && m.labels.includes('STARRED'));
                  }
                  if (activeFilter === 'attachments') return !!m.hasAttachments;
                  return true;
                })
          )}
          renderItem={renderEmail}
          renderSectionHeader={renderSectionHeader}
          keyExtractor={(item) => `email-${item.id}`}
          contentContainerStyle={styles.listContainer}
          // Search + filter chips live inside the list so they scroll away and
          // back with the content. They used to be siblings above the list,
          // toggled by an onScroll threshold, which unmounted ~95px of layout on
          // every crossing — that reflow made the rows jump ("glitchy" scroll)
          // and spuriously engaged the pull-to-refresh at the top.
          ListHeaderComponent={(
            <View style={{ backgroundColor: colors.background }}>
              {/* WhatsApp-style search field */}
              <View style={[styles.waSearchContainer, { backgroundColor: colors.background }]}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => router.push('/search')}
                  style={[styles.waSearchBar, { backgroundColor: isDark ? '#333333' : '#F3F3F3' }]}
                >
                  <Search size={18} color={isDark ? '#818F99' : '#4D5C66'} strokeWidth={2.5} />
                  <Text style={[styles.waSearchPlaceholder, { color: isDark ? '#818F99' : '#4D5C66' }]} numberOfLines={1}>
                    Search
                  </Text>
                </TouchableOpacity>
              </View>

              {/* WhatsApp-style filter chips */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.waChipsRow}
                style={{ backgroundColor: colors.background, flexGrow: 0, flexShrink: 0 }}
              >
                {filterChips.map(chip => {
                  const selected = activeFilter === chip.key;
                  return (
                    <TouchableOpacity
                      key={chip.key}
                      onPress={() => setActiveFilter(chip.key)}
                      activeOpacity={0.75}
                      style={[
                        styles.waChip,
                        selected
                          ? { backgroundColor: isDark ? '#FFFFFF' : '#111827' }
                          : { backgroundColor: 'transparent', borderColor: isDark ? '#4A555C' : '#C7C7CC', borderWidth: StyleSheet.hairlineWidth },
                      ]}
                    >
                      <Text
                        style={[
                          styles.waChipText,
                          {
                            color: selected
                              ? (isDark ? '#111827' : '#FFFFFF')
                              : (isDark ? '#C8C8CB' : '#4D5C66'),
                            fontWeight: selected ? '600' : '500',
                          },
                        ]}
                        numberOfLines={1}
                      >
                        {chip.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          )}
          ListEmptyComponent={renderEmptyState}
          showsVerticalScrollIndicator={false}
          // Native drag-to-refresh — works reliably on both iOS and Android
          // (the previous bounce-based custom pull never triggered on Android,
          // which lacks negative overscroll offsets).
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={isDark ? '#8AB4F8' : '#4285F4'}
              colors={[isDark ? '#8AB4F8' : '#4285F4']}
              progressBackgroundColor={isDark ? '#1F1F23' : '#FFFFFF'}
            />
          }
          stickySectionHeadersEnabled={false}
        />
      </Animated.View>

      {/* Floating Compose Button — Gmail extended FAB */}
      <Animated.View style={[styles.fab, { backgroundColor: isDark ? '#8AB4F8' : '#C2E7FF', bottom: insets.bottom + 16, transform: [{ translateY: fabTranslateY }] }, isTablet && { right: 28 }]}>
        <TouchableOpacity
          onPress={handleOpenCompose}
          activeOpacity={0.85}
          style={styles.fabInner}
        >
          <Edit3 size={20} color={isDark ? '#1F1F23' : '#001D35'} strokeWidth={2} />
          <Text style={[styles.fabLabel, { color: isDark ? '#1F1F23' : '#001D35' }]}>Compose</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Snackbar — below FAB */}
      {snackbar && (
        <Animated.View style={[styles.snackbar, { bottom: insets.bottom + 8, transform: [{ translateY: snackbarTranslateY }] }]}>
          <Text style={styles.snackbarText}>{snackbar}</Text>
          {/* Snooze undo */}
          {snackbar.startsWith('Snoozed') && (
            <TouchableOpacity onPress={handleSnoozeUndo} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.snackbarAction}>Undo</Text>
            </TouchableOpacity>
          )}
          {/* Draft discarded — undo re-saves */}
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
              <Text style={styles.snackbarAction}>Undo</Text>
            </TouchableOpacity>
          )}
          {/* Draft saved — discard deletes */}
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
              <Text style={styles.snackbarAction}>Discard</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      )}

      {/* Snooze Picker Modal */}
      <SnoozePickerModal
        visible={snoozePickerVisible}
        onClose={() => { setSnoozePickerVisible(false); setSnoozeTargetId(null); }}
        onSelect={handleSnoozeSelect}
      />

    </View>
  );

  if (isTablet) {
    return (
      <View style={styles.splitContainer}>
        <AccountMiniSidebar />
        <LabelPanel
          visible={labelPanelVisible}
          onLabelSelected={() => setLabelPanelVisible(false)}
        />
        <View style={{ width: EMAIL_LIST_WIDTH_TABLET, borderRightWidth: 0.5, borderRightColor: '#E5E7EB' }}>
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


