import { styles } from './[id].styles';
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Alert,
  ActionSheetIOS,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronLeft,
  Star,
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Archive,
  Paperclip,
  ChevronUp,
  ChevronDown,
  Lock,
  MoreVertical,
  Pin,
  Clock,
  Tag,
  Download,
  File,
  FileText,
  FileImage,
  FileSpreadsheet,
  FileArchive,
  FileVideo,
  FileAudio,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import EmailHtmlView from '@/components/EmailHtmlView';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { formatFullDateTime } from '@weldsuite/mobile-ui/utils/dateFormatter';
import appApi from '@/services/app-api';
import { isApiError } from '@weldsuite/api-client/client';
import { useMailCache } from '@/hooks/useMailCache';
import { useMailOutbox } from '@/hooks/useMailOutbox';
import { useMail } from '@/contexts/MailContext';
import { usePinnedMessages } from '@/contexts/PinnedMessagesContext';
import { useComposeOverlay } from '@/contexts/ComposeOverlayContext';
import SnoozePickerModal from '@/components/SnoozePickerModal';
import LabelPickerModal from '@/components/LabelPickerModal';
import {
  getSenderName,
  getSenderEmail,
  formatRecipients,
  formatFileSize,
  formatMessageDate,
  buildComposeParams,
} from '@/utils/email-format';
import { openAttachment } from '@/utils/open-attachment';
import { getAttachmentVisual, type AttachmentKind } from '@/utils/attachment-visual';

// Icon component per attachment kind (see utils/attachment-visual).
const ATTACHMENT_ICONS: Record<AttachmentKind, React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>> = {
  image: FileImage,
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: FileText,
  archive: FileArchive,
  video: FileVideo,
  audio: FileAudio,
  file: File,
};

// Platform format: `format(date, 'd MMM, HH:mm')` → "15 Mar, 14:30"
function formatPlatformDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const day = date.getDate();
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  return `${day} ${month}, ${hh}:${mm}`;
}

// Platform's exact 10-color avatar palette (white text on solid color).
function getInitialColor(name: string): string {
  const colors = [
    '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
    '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}


function ThreadMessage({ message, colors, isExpanded, onToggle, onReply, onReplyAll, onForward, router }: {
  message: any;
  colors: any;
  isExpanded: boolean;
  onToggle: () => void;
  onReply: (msg: any) => void;
  onReplyAll: (msg: any) => void;
  onForward: (msg: any) => void;
  router: any;
}) {
  const senderName = getSenderName(message.from);
  const senderEmail = getSenderEmail(message.from);
  const avatarColor = getInitialColor(senderName);

  const toStr = typeof message.to === 'string' ? message.to : formatRecipients(message.to);
  const ccStr = typeof message.cc === 'string' ? message.cc : formatRecipients(message.cc);
  const toCount = toStr ? toStr.split(/[,;]\s*/).filter(Boolean).length : 0;
  const ccCount = ccStr ? ccStr.split(/[,;]\s*/).filter(Boolean).length : 0;
  const hasMultipleRecipients = (toCount + ccCount) > 1;

  if (!isExpanded) {
    return (
      <TouchableOpacity
        onPress={onToggle}
        style={styles.threadCollapsed}
        activeOpacity={0.7}
      >
        <View style={[styles.threadAvatar, { backgroundColor: avatarColor }]}>
          <Text style={styles.threadAvatarText}>
            {senderName.charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.threadCollapsedContent}>
          <Text style={[styles.threadSenderName, { color: colors.text }]} numberOfLines={1}>
            {senderName}
          </Text>
        </View>
        <View style={styles.threadDateGroup}>
          <Text style={[styles.threadDate, { color: colors.muted }]}>
            {formatMessageDate(message.sentDate || message.receivedDate)}
          </Text>
          <ChevronDown size={16} color={colors.muted} strokeWidth={2} />
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.threadExpanded}>
      {/* Thread message header */}
      <TouchableOpacity onPress={onToggle} activeOpacity={0.7} style={styles.threadExpandedHeader}>
        <TouchableOpacity
          onPress={() => router.push(`/contact/${encodeURIComponent(senderEmail || senderName)}` as any)}
          activeOpacity={0.7}
        >
          <View style={[styles.threadAvatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.threadAvatarText}>
              {senderName.charAt(0).toUpperCase()}
            </Text>
          </View>
        </TouchableOpacity>
        <View style={styles.threadExpandedSender}>
          <Text style={[styles.threadSenderName, { color: colors.text }]}>{senderName}</Text>
          <Text style={[styles.threadRecipientText, { color: colors.muted }]} numberOfLines={1}>
            to {toStr || 'me'}
          </Text>
        </View>
        <Text style={[styles.threadDate, { color: colors.muted }]}>
          {formatMessageDate(message.sentDate || message.receivedDate)}
        </Text>
        <ChevronUp size={16} color={colors.muted} strokeWidth={2} style={{ marginLeft: 4 }} />
      </TouchableOpacity>

      {/* Thread message body */}
      <View style={styles.threadBody}>
        {(message.htmlBody) ? (
          <EmailHtmlView
            html={message.htmlBody}
            textColor={colors.text}
            fontSize={15}
            lineHeight={1.6}
            hideQuotes
            style={styles.webViewBody}
          />
        ) : (
          <Text style={[styles.threadBodyText, { color: colors.text }]}>
            {message.textBody || message.preview || 'No content'}
          </Text>
        )}
      </View>

      {/* Thread message actions */}
      <View style={styles.threadActions}>
        <TouchableOpacity
          style={[styles.threadActionButton, { borderColor: '#E5E7EB' }]}
          onPress={() => onReply(message)}
          activeOpacity={0.7}
        >
          <Reply size={15} color={colors.text} strokeWidth={2} />
          <Text style={[styles.threadActionText, { color: colors.text }]}>Reply</Text>
        </TouchableOpacity>
        {hasMultipleRecipients && (
          <TouchableOpacity
            style={[styles.threadActionButton, { borderColor: '#E5E7EB' }]}
            onPress={() => onReplyAll(message)}
            activeOpacity={0.7}
          >
            <ReplyAll size={15} color={colors.text} strokeWidth={2} />
            <Text style={[styles.threadActionText, { color: colors.text }]}>Reply All</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.threadActionButton, { borderColor: '#E5E7EB' }]}
          onPress={() => onForward(message)}
          activeOpacity={0.7}
        >
          <Forward size={15} color={colors.text} strokeWidth={2} />
          <Text style={[styles.threadActionText, { color: colors.text }]}>Forward</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}


export default function EmailDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme, colors } = useTheme();
  const isDark = theme === 'dark';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accounts, refreshMail } = useMail();
  const cache = useMailCache();
  const outbox = useMailOutbox();
  const { isPinned: isMessagePinned, togglePin } = usePinnedMessages();
  const { openCompose: openComposeOverlay } = useComposeOverlay();

  const [email, setEmail] = useState<any>(null);
  const [threadMessages, setThreadMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // How the message load ended when there's nothing to show: a real 404 (the
  // message is genuinely gone) vs a transient failure (offline / token not
  // ready / 5xx) that a Retry can recover. Keeps a network blip from lying
  // "Email not found".
  const [loadOutcome, setLoadOutcome] = useState<'gone' | 'failed' | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [showEmailDetails, setShowEmailDetails] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(new Set());
  const [snoozePickerVisible, setSnoozePickerVisible] = useState(false);
  const [labelPickerVisible, setLabelPickerVisible] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadOutcome(null);
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const load = async () => {
      // Cache-first: if we've opened this email before, show it (and its thread)
      // instantly, so a re-open works offline and there's no spinner online.
      const [cachedMsg, cachedThread] = await Promise.all([cache.getMessage(id), cache.getThread(id)]);
      if (cancelled) return;
      if (cachedMsg) {
        setEmail(cachedMsg);
        if (cachedThread) setThreadMessages((cachedThread as any[]).filter((m) => m.id !== id));
        setLoading(false);
      }

      // Fetch the message with a few retries. Only a genuine 404 means the
      // message is really gone; a network drop, a not-yet-ready auth token, or
      // a 5xx are transient and must NOT surface as "Email not found" — we
      // retry, then fall back to a retryable error state.
      let fetched: any = null;
      let gone = false;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const res = await appApi.mailMessages.get(id);
          fetched = res.data;
          break;
        } catch (err) {
          if (isApiError(err) && err.status === 404) {
            gone = true;
            break;
          }
          if (attempt < 2) await delay(300 * (attempt + 1));
        }
      }
      if (cancelled) return;

      if (fetched) {
        setEmail(fetched);
        setLoadOutcome(null);
        cache.setMessage(id, fetched as Record<string, unknown>);
        appApi.mailMessages.update(id, { isRead: true }).catch(() => {});
      } else if (gone) {
        // Genuinely gone server-side. If we had nothing cached, the tapped row
        // was a stale/dead entry in the list — re-sync so it disappears.
        if (!cachedMsg) {
          setLoadOutcome('gone');
          refreshMail();
        }
      } else if (!cachedMsg) {
        // Couldn't reach it after retries and have nothing to show — offer a
        // retry instead of a misleading "not found".
        setLoadOutcome('failed');
      }

      // Thread is best-effort and must never gate the message view.
      try {
        const t = await appApi.mailMessages.thread(id);
        if (!cancelled) {
          cache.setThread(id, t.data.messages);
          setThreadMessages(t.data.messages.filter((m: any) => m.id !== id));
        }
      } catch {
        // Keep any cached thread already shown.
      }

      if (!cancelled) setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [id, cache, reloadTick]);

  const retryLoad = useCallback(() => {
    setLoading(true);
    setLoadOutcome(null);
    setReloadTick((t) => t + 1);
  }, []);

  const toggleThreadExpanded = useCallback((messageId: string) => {
    setExpandedThreadIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleStarToggle = async () => {
    if (!email) return;
    const wasStarred = email.isStarred;
    setEmail({ ...email, isStarred: !wasStarred });
    // Durable + offline-safe: queues the change and flushes when online. Never
    // throws on a connectivity failure, so the optimistic star stays put.
    await outbox.update(email.id, { isStarred: !wasStarred });
    refreshMail();
  };

  // Pin is client-side only (no backend field) — toggle it in the shared
  // PinnedMessages context so the inbox reflects it too.
  const handlePinToggle = () => {
    if (!email) return;
    togglePin(email.id);
  };

  const handleDelete = async () => {
    if (!email) return;
    // Queue the delete (replays on reconnect) and leave — the inbox overlay
    // hides it immediately, online or off.
    await outbox.remove(email.id);
    refreshMail();
    router.back();
  };

  const handleArchive = async () => {
    if (!email) return;
    await outbox.archive(email.id);
    refreshMail();
    router.back();
  };

  const handleMarkAsUnread = useCallback(async () => {
    if (!email) return;
    await outbox.update(email.id, { isRead: false });
    refreshMail();
    router.back();
  }, [email, router, refreshMail, outbox]);

  const handleMoreMenuAction = useCallback((buttonIndex: number) => {
    if (!email) return;
    switch (buttonIndex) {
      case 0: // Mark as unread
        handleMarkAsUnread();
        break;
      case 1: // Delete
        handleDelete();
        break;
      case 2: // Mark as spam
        outbox.update(email.id, { isSpam: true }).then(() => { refreshMail(); router.back(); });
        break;
      case 3: // Report phishing
        outbox.update(email.id, { isSpam: true }).then(() => {
          refreshMail();
          Alert.alert('Reported', 'This message has been reported as phishing.');
          router.back();
        });
        break;
      default:
        break;
    }
  }, [email, router, handleMarkAsUnread, refreshMail, outbox]);

  const handleMoreMenu = () => {
    const options = ['Mark as unread', 'Delete', 'Mark as spam', 'Report phishing', 'Cancel'];
    const cancelButtonIndex = options.length - 1;
    const destructiveButtonIndex = [1, 2]; // Delete + Mark as spam

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex, destructiveButtonIndex },
        (buttonIndex) => handleMoreMenuAction(buttonIndex),
      );
    } else {
      Alert.alert('Actions', undefined, [
        { text: 'Mark as unread', onPress: () => handleMoreMenuAction(0) },
        { text: 'Delete', style: 'destructive', onPress: () => handleMoreMenuAction(1) },
        { text: 'Mark as spam', style: 'destructive', onPress: () => handleMoreMenuAction(2) },
        { text: 'Report phishing', onPress: () => handleMoreMenuAction(3) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const handleSnoozeSelect = useCallback(async (until: string, _label: string) => {
    setSnoozePickerVisible(false);
    if (!email) return;
    const accountId = email.accountId || '';
    await outbox.snooze(email.id, accountId, until);
    refreshMail();
    router.back();
  }, [email, router, refreshMail, outbox]);

  const handleLabelsChanged = useCallback((newLabels: string[]) => {
    if (email) setEmail({ ...email, labels: newLabels });
    refreshMail();
  }, [email, refreshMail]);

  const openComposeForMessage = (msg: any, mode: 'reply' | 'replyAll' | 'forward') => {
    openComposeOverlay(
      buildComposeParams(msg, mode, email?.emailAccountId || email?.accountId || ''),
    );
  };

  const openCompose = (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!email) return;
    openComposeForMessage(email, mode);
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        {/* ActivityIndicator animates on the UI thread, so it stays smooth even
            while the JS thread is busy with the navigation + fetch that opening
            an email kicks off (MaterialSpinner's SVG animation janks there). */}
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!email) {
    // A real 404 → the message is gone. Anything else (offline / token / 5xx)
    // is transient and gets a Retry rather than a false "not found".
    const isGone = loadOutcome === 'gone';
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>
          {isGone ? 'Email not found' : "Couldn't load this email"}
        </Text>
        {!isGone && (
          <TouchableOpacity
            onPress={retryLoad}
            style={{ marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: '#4D94F8' }}
            activeOpacity={0.7}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  const senderName = getSenderName(email.from) || email.fromName || 'Unknown';
  const senderEmail = email.fromEmail || getSenderEmail(email.from);
  const avatarColor = getInitialColor(senderName);

  // Determine if Reply All makes sense
  const toStr = typeof email.to === 'string' ? email.to : formatRecipients(email.to);
  const ccStr = typeof email.cc === 'string' ? email.cc : formatRecipients(email.cc);
  const toCount = toStr ? toStr.split(/[,;]\s*/).filter(Boolean).length : 0;
  const ccCount = ccStr ? ccStr.split(/[,;]\s*/).filter(Boolean).length : 0;
  const hasMultipleRecipients = (toCount + ccCount) > 1;

  // Older thread messages (everything except current email, newest first below)
  const olderMessages = threadMessages.filter(m => m.id !== id).reverse();
  const hasThread = olderMessages.length > 0;
  const threadCount = olderMessages.length + 1; // Include current message

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Top Header Bar — subject inline + actions */}
      <View
        style={[
          styles.topHeader,
          {
            paddingTop: insets.top,
            backgroundColor: colors.background,
            borderBottomColor: '#E5E7EB',
          },
        ]}
      >
        <View style={styles.topHeaderRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.topHeaderBack}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <ChevronLeft size={24} color="#4B5563" strokeWidth={2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <View style={styles.topHeaderActions}>
            <TouchableOpacity
              onPress={handleStarToggle}
              style={styles.topHeaderIconBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Star
                size={18}
                color={email.isStarred ? '#EAB308' : '#6B7280'}
                fill={email.isStarred ? '#EAB308' : 'transparent'}
                strokeWidth={2}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handlePinToggle}
              style={styles.topHeaderIconBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Pin
                size={18}
                color={isMessagePinned(email.id) ? '#3B82F6' : '#6B7280'}
                fill={isMessagePinned(email.id) ? '#3B82F6' : 'transparent'}
                strokeWidth={2}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleArchive}
              style={styles.topHeaderIconBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Archive size={18} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setSnoozePickerVisible(true)}
              style={styles.topHeaderIconBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Clock size={18} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setLabelPickerVisible(true)}
              style={styles.topHeaderIconBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Tag size={18} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleMoreMenu}
              style={styles.topHeaderIconBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <MoreVertical size={18} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
        scrollEventThrottle={16}
      >
        {/* Subject heading — large, below the header bar */}
        <View style={styles.subjectBlock}>
          <Text style={[styles.subjectText, { color: colors.text }]}>
            {email.subject || '(no subject)'}
          </Text>
          {hasThread && (
            <View style={styles.subjectThreadBadge}>
              <Text style={styles.subjectThreadBadgeText}>{threadCount}</Text>
            </View>
          )}
        </View>

        {/* Sender Header — avatar | name to email | date · more */}
        <View style={styles.senderHeader}>
          <View style={styles.senderLeft}>
            <TouchableOpacity
              onPress={() => router.push(`/contact/${encodeURIComponent(senderEmail || senderName)}` as any)}
              activeOpacity={0.7}
            >
              <View style={[styles.senderAvatar, { backgroundColor: avatarColor }]}>
                <Text style={styles.senderAvatarText}>
                  {senderName.charAt(0).toUpperCase()}
                </Text>
              </View>
            </TouchableOpacity>
            <View style={styles.senderInfo}>
              <View style={styles.senderLineWrap}>
                <TouchableOpacity
                  onPress={() => router.push(`/contact/${encodeURIComponent(senderEmail || senderName)}` as any)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.senderName, { color: colors.text }]} numberOfLines={1}>
                    {senderName}
                  </Text>
                </TouchableOpacity>
                <Text style={styles.senderToWord}>to</Text>
                <TouchableOpacity
                  onPress={() => setShowEmailDetails(!showEmailDetails)}
                  activeOpacity={0.7}
                  style={styles.senderRecipientWrap}
                >
                  <Text style={styles.senderRecipientEmail} numberOfLines={1}>
                    {(typeof email.to === 'string' ? email.to : formatRecipients(email.to)) || 'me'}
                  </Text>
                  {showEmailDetails ? (
                    <ChevronUp size={13} color="#3B82F6" strokeWidth={2} />
                  ) : (
                    <ChevronDown size={13} color="#3B82F6" strokeWidth={2} />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
          <Text style={styles.senderDate}>
            {formatPlatformDate(email.receivedAt || email.receivedDate || email.createdAt)}
          </Text>
        </View>

        {/* Email Details Panel */}
        {showEmailDetails && (
          <View style={[styles.detailsPanel, { borderColor: '#E5E7EB' }]}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>From</Text>
              <View style={styles.detailValue}>
                <Text style={[styles.detailName, { color: colors.text }]}>{senderName}</Text>
                <Text style={styles.detailEmail}>{senderEmail}</Text>
              </View>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>To</Text>
              <Text style={[styles.detailEmailLine, { color: colors.text }]}>
                {typeof email.to === 'string' ? email.to : formatRecipients(email.to)}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Date</Text>
              <Text style={[styles.detailEmailLine, { color: colors.text }]}>
                {(() => {
                  const d = email.receivedAt || email.receivedDate || email.createdAt;
                  if (!d) return '';
                  const date = new Date(d);
                  if (isNaN(date.getTime())) return '';
                  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })} ${date.getFullYear()} at ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
                })()}
              </Text>
            </View>
            <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
              <Lock size={14} color="#6B7280" strokeWidth={2} style={{ marginTop: 2 }} />
              <Text style={[styles.detailEmailLine, { color: colors.text, marginLeft: 6 }]}>
                Standard encryption (TLS)
              </Text>
            </View>
          </View>
        )}

        {/* Email Body */}
        <View style={styles.bodySection}>
          {(email.bodyHtml || email.htmlBody || email.htmlContent) ? (
            <EmailHtmlView
              html={email.bodyHtml || email.htmlBody || email.htmlContent}
              textColor={colors.text}
              fontSize={14}
              lineHeight={1.625}
              initialHeight={300}
              style={styles.webViewBody}
            />
          ) : (
            <Text style={[styles.body, { color: colors.text }]}>
              {email.textContent || email.body || email.preview || email.snippet || 'No content'}
            </Text>
          )}
        </View>

        {/* Attachments — Gmail-style cards in a horizontal rail with typed icons */}
        {email.attachments && email.attachments.length > 0 && (
          <View style={styles.attachmentsBlock}>
            <View style={styles.attachmentsHeader}>
              <Paperclip size={13} color="#6B7280" strokeWidth={2} />
              <Text style={styles.attachmentsHeaderText}>
                {email.attachments.length} {email.attachments.length === 1 ? 'ATTACHMENT' : 'ATTACHMENTS'}
              </Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.attachmentRail}
            >
              {email.attachments.map((attachment: any) => {
                const name = attachment.fileName || attachment.filename || attachment.name || 'Attachment';
                const { kind, color, ext } = getAttachmentVisual(name);
                const Icon = ATTACHMENT_ICONS[kind];
                return (
                  <TouchableOpacity
                    key={attachment.id || name}
                    style={[styles.attachmentCard, { borderColor: colors.border || '#E5E7EB', backgroundColor: isDark ? '#1F1F23' : '#FFFFFF' }]}
                    activeOpacity={0.7}
                    onPress={() => openAttachment(attachment)}
                  >
                    <View style={[styles.attachmentCardIcon, { backgroundColor: color + '1A' }]}>
                      <Icon size={20} color={color} strokeWidth={2} />
                    </View>
                    <View style={styles.attachmentCardMeta}>
                      <Text style={[styles.attachmentCardName, { color: colors.text }]} numberOfLines={1}>
                        {name}
                      </Text>
                      <Text style={styles.attachmentCardSub} numberOfLines={1}>
                        {[ext, attachment.size > 0 ? formatFileSize(attachment.size) : ''].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Download size={16} color="#9CA3AF" strokeWidth={2} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* Previous Conversations */}
        {hasThread && (
          <View style={styles.threadSection}>
            {olderMessages.map((msg) => (
              <ThreadMessage
                key={msg.id}
                message={msg}
                colors={colors}
                isExpanded={expandedThreadIds.has(msg.id)}
                onToggle={() => toggleThreadExpanded(msg.id)}
                onReply={(m) => openComposeForMessage(m, 'reply')}
                onReplyAll={(m) => openComposeForMessage(m, 'replyAll')}
                onForward={(m) => openComposeForMessage(m, 'forward')}
                router={router}
              />
            ))}
          </View>
        )}

        {/* Spacer so last content isn't hidden behind the fixed action bar */}
        <View style={{ height: 60 + insets.bottom }} />
      </ScrollView>

      {/* Gmail-style fixed action bar */}
      <View
        style={[
          styles.actionBar,
          {
            paddingBottom: insets.bottom + 6,
            backgroundColor: colors.background,
            borderTopColor: colors.border || colors.divider || '#E5E7EB',
          },
        ]}
      >
        <TouchableOpacity
          style={[
            styles.actionBarBtn,
            {
              backgroundColor: isDark ? '#1F1F23' : '#FFFFFF',
              borderColor: isDark ? '#3F3F46' : '#E5E7EB',
            },
          ]}
          activeOpacity={0.7}
          onPress={() => openCompose('reply')}
        >
          <Reply size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.actionBarText, { color: colors.text }]}>Reply</Text>
        </TouchableOpacity>
        {hasMultipleRecipients && (
          <TouchableOpacity
            style={[
            styles.actionBarBtn,
            {
              backgroundColor: isDark ? '#1F1F23' : '#FFFFFF',
              borderColor: isDark ? '#3F3F46' : '#E5E7EB',
            },
          ]}
            activeOpacity={0.7}
            onPress={() => openCompose('replyAll')}
          >
            <ReplyAll size={16} color={colors.text} strokeWidth={2} />
            <Text style={[styles.actionBarText, { color: colors.text }]}>Reply all</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[
            styles.actionBarBtn,
            {
              backgroundColor: isDark ? '#1F1F23' : '#FFFFFF',
              borderColor: isDark ? '#3F3F46' : '#E5E7EB',
            },
          ]}
          activeOpacity={0.7}
          onPress={() => openCompose('forward')}
        >
          <Forward size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.actionBarText, { color: colors.text }]}>Forward</Text>
        </TouchableOpacity>
      </View>

      {/* Snooze Picker */}
      <SnoozePickerModal
        visible={snoozePickerVisible}
        onClose={() => setSnoozePickerVisible(false)}
        onSelect={handleSnoozeSelect}
      />

      {/* Label Picker */}
      <LabelPickerModal
        visible={labelPickerVisible}
        onClose={() => setLabelPickerVisible(false)}
        messageId={email.id}
        currentLabels={(email.labels as string[]) || []}
        onLabelsChanged={handleLabelsChanged}
      />

    </View>
  );
}


