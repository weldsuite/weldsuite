import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActionSheetIOS,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
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
  Mail,
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
import appApi from '@/services/app-api';
import { isApiError } from '@weldsuite/api-client/client';
import { useMailOutbox } from '@/hooks/useMailOutbox';
import { useMail } from '@/contexts/MailContext';
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

function getInitialColor(name: string): string {
  const colors = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#6366F1', '#EF4444', '#14B8A6'];
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

  const avatar = (
    <View style={[styles.threadAvatar, { backgroundColor: avatarColor + '20' }]}>
      <Text style={[styles.threadAvatarText, { color: avatarColor }]}>
        {senderName.charAt(0).toUpperCase()}
      </Text>
    </View>
  );

  if (!isExpanded) {
    return (
      <TouchableOpacity
        onPress={onToggle}
        style={[styles.threadCollapsed, { borderBottomColor: colors.border || '#E5E7EB' }]}
        activeOpacity={0.6}
      >
        {avatar}
        <View style={styles.threadCollapsedContent}>
          <Text style={[styles.threadSenderName, { color: colors.text }]} numberOfLines={1}>
            {senderName}
          </Text>
          <Text style={[styles.threadPreview, { color: colors.muted }]} numberOfLines={1}>
            {message.preview || message.textBody || '(No preview)'}
          </Text>
        </View>
        <Text style={[styles.threadDate, { color: colors.muted }]}>
          {formatMessageDate(message.sentDate || message.receivedDate)}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.threadExpanded, { borderBottomColor: colors.border || '#E5E7EB' }]}>
      <TouchableOpacity onPress={onToggle} activeOpacity={0.6} style={styles.threadExpandedHeader}>
        {avatar}
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

      <View style={styles.threadBody}>
        {(message.htmlBody) ? (
          <EmailHtmlView
            html={message.htmlBody}
            textColor={colors.text}
            fontSize={16}
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

      <View style={styles.threadActions}>
        <TouchableOpacity
          style={[styles.threadActionButton, { borderColor: '#E5E7EB' }]}
          onPress={() => onReply(message)}
          activeOpacity={0.7}
        >
          <Reply size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.threadActionText, { color: colors.text }]}>Reply</Text>
        </TouchableOpacity>
        {hasMultipleRecipients && (
          <TouchableOpacity
            style={[styles.threadActionButton, { borderColor: '#E5E7EB' }]}
            onPress={() => onReplyAll(message)}
            activeOpacity={0.7}
          >
            <ReplyAll size={16} color={colors.text} strokeWidth={2} />
            <Text style={[styles.threadActionText, { color: colors.text }]}>Reply All</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.threadActionButton, { borderColor: '#E5E7EB' }]}
          onPress={() => onForward(message)}
          activeOpacity={0.7}
        >
          <Forward size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.threadActionText, { color: colors.text }]}>Forward</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

interface EmailDetailPanelProps {
  emailId: string | null;
  onEmailDeleted?: (id: string) => void;
  onEmailArchived?: (id: string) => void;
}

export default function EmailDetailPanel({ emailId, onEmailDeleted, onEmailArchived }: EmailDetailPanelProps) {
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accounts } = useMail();
  const outbox = useMailOutbox();
  const { openCompose: openComposeOverlay } = useComposeOverlay();

  const [email, setEmail] = useState<any>(null);
  const [threadMessages, setThreadMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // 'gone' = a real 404 (message deleted server-side); 'failed' = a transient
  // failure (offline / token not ready / 5xx) that Retry can recover. Keeps a
  // network blip from falsely reading "Email not found".
  const [loadOutcome, setLoadOutcome] = useState<'gone' | 'failed' | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [showEmailDetails, setShowEmailDetails] = useState(false);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(new Set());
  const [snoozePickerVisible, setSnoozePickerVisible] = useState(false);
  const [labelPickerVisible, setLabelPickerVisible] = useState(false);

  useEffect(() => {
    if (!emailId) {
      setEmail(null);
      setThreadMessages([]);
      return;
    }
    setLoading(true);
    setLoadOutcome(null);
    setShowEmailDetails(false);
    setExpandedThreadIds(new Set());
    let cancelled = false;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const load = async () => {
      // Fetch the message with a few retries. Only a genuine 404 means it's
      // really gone; a network drop, a not-yet-ready auth token, or a 5xx are
      // transient and must NOT surface as "Email not found".
      let fetched: any = null;
      let gone = false;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const res = await appApi.mailMessages.get(emailId);
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
        appApi.mailMessages.update(emailId, { isRead: true }).catch(() => {});
      } else {
        setEmail(null);
        setLoadOutcome(gone ? 'gone' : 'failed');
      }

      // Thread is best-effort and must never gate the message view.
      try {
        const t = await appApi.mailMessages.thread(emailId);
        if (!cancelled) setThreadMessages(t.data.messages.filter((m: any) => m.id !== emailId));
      } catch {
        // ignore — a threadless email or a transient thread error is harmless.
      }

      if (!cancelled) setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [emailId, reloadTick]);

  const retryLoad = useCallback(() => {
    setLoading(true);
    setLoadOutcome(null);
    setReloadTick((t) => t + 1);
  }, []);

  const toggleThreadExpanded = useCallback((messageId: string) => {
    setExpandedThreadIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const handleStarToggle = async () => {
    if (!email) return;
    const wasStarred = email.isStarred;
    setEmail({ ...email, isStarred: !wasStarred });
    // Durable + offline-safe; never throws on a connectivity failure.
    await outbox.update(email.id, { isStarred: !wasStarred });
  };

  const handleDelete = async () => {
    if (!email) return;
    await outbox.remove(email.id);
    onEmailDeleted?.(email.id);
  };

  const handleArchive = async () => {
    if (!email) return;
    await outbox.archive(email.id);
    onEmailArchived?.(email.id);
  };

  const handleMoreMenuAction = useCallback((buttonIndex: number) => {
    if (!email) return;
    switch (buttonIndex) {
      case 0:
        setSnoozePickerVisible(true);
        break;
      case 1:
        setLabelPickerVisible(true);
        break;
      case 2:
        outbox.update(email.id, { isSpam: true }).then(() => onEmailDeleted?.(email.id));
        break;
      case 3:
        outbox.update(email.id, { isSpam: true }).then(() => {
          Alert.alert('Reported', 'This message has been reported as phishing.');
          onEmailDeleted?.(email.id);
        });
        break;
    }
  }, [email, onEmailDeleted, outbox]);

  const handleMoreMenu = () => {
    const options = ['Snooze', 'Label', 'Mark as spam', 'Report phishing', 'Cancel'];
    const cancelButtonIndex = options.length - 1;
    const destructiveButtonIndex = 2;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex, destructiveButtonIndex },
        (buttonIndex) => handleMoreMenuAction(buttonIndex),
      );
    } else {
      Alert.alert('Actions', undefined, [
        { text: 'Snooze', onPress: () => handleMoreMenuAction(0) },
        { text: 'Label', onPress: () => handleMoreMenuAction(1) },
        { text: 'Mark as spam', style: 'destructive', onPress: () => handleMoreMenuAction(2) },
        { text: 'Report phishing', onPress: () => handleMoreMenuAction(3) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const handleSnoozeSelect = useCallback(async (until: string, _label: string) => {
    setSnoozePickerVisible(false);
    if (!email) return;
    const accountId = (email as any).accountId || '';
    await outbox.snooze(email.id, accountId, until);
    onEmailDeleted?.(email.id);
  }, [email, onEmailDeleted, outbox]);

  const handleLabelsChanged = useCallback((newLabels: string[]) => {
    if (email) setEmail({ ...email, labels: newLabels });
  }, [email]);

  const openComposeForMessage = (msg: any, mode: 'reply' | 'replyAll' | 'forward') => {
    openComposeOverlay(
      buildComposeParams(msg, mode, email?.emailAccountId || email?.accountId || ''),
    );
  };

  const openCompose = (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!email) return;
    openComposeForMessage(email, mode);
  };

  // Empty state
  if (!emailId) {
    return (
      <View style={[styles.emptyContainer, { backgroundColor: colors.background }]}>
        <Mail size={48} color={colors.divider} strokeWidth={1} />
        <Text style={[styles.emptyText, { color: colors.muted }]}>Select an email to read</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        {/* UI-thread spinner — stays smooth while the JS thread is busy fetching. */}
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!email) {
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

  const toStr = typeof email.to === 'string' ? email.to : formatRecipients(email.to);
  const ccStr = typeof email.cc === 'string' ? email.cc : formatRecipients(email.cc);
  const toCount = toStr ? toStr.split(/[,;]\s*/).filter(Boolean).length : 0;
  const ccCount = ccStr ? ccStr.split(/[,;]\s*/).filter(Boolean).length : 0;
  const hasMultipleRecipients = (toCount + ccCount) > 1;

  const olderMessages = threadMessages.filter(m => m.id !== emailId).reverse();
  const hasThread = olderMessages.length > 0;
  const threadCount = olderMessages.length + 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header toolbar */}
      <View style={[styles.fixedHeader, { paddingTop: insets.top + 4, backgroundColor: colors.background }]}>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={handleStarToggle} style={styles.actionButton}>
            <Star
              size={22}
              color={email.isStarred ? '#F59E0B' : colors.muted}
              fill={email.isStarred ? '#F59E0B' : 'transparent'}
              strokeWidth={2}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleArchive} style={styles.actionButton}>
            <Archive size={22} color="#4B5563" strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleDelete} style={styles.actionButton}>
            <Trash2 size={22} color="#4B5563" strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleMoreMenu} style={styles.actionButton}>
            <MoreVertical size={22} color="#4B5563" strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Subject */}
        <View style={styles.emailHeader}>
          <View style={styles.subjectLine}>
            <Text style={[styles.subjectText, { color: colors.text }]}>
              {email.subject || '(no subject)'}
            </Text>
            {hasThread && (
              <View style={styles.threadBadge}>
                <Text style={styles.threadBadgeText}>{threadCount}</Text>
              </View>
            )}
          </View>

          {/* Sender info */}
          <View style={styles.senderSection}>
            <View style={[styles.senderAvatar, { backgroundColor: avatarColor + '20' }]}>
              <Text style={[styles.senderAvatarText, { color: avatarColor }]}>
                {senderName.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.senderInfo}>
              <View style={styles.senderNameRow}>
                <Text style={[styles.senderNameText, { color: colors.text }]}>
                  {senderName}
                </Text>
                <TouchableOpacity
                  style={styles.toMeRow}
                  onPress={() => setShowEmailDetails(!showEmailDetails)}
                  activeOpacity={0.6}
                >
                  <Text style={[styles.recipientLabel, { color: '#6B7280' }]}>to me</Text>
                  {showEmailDetails ? (
                    <ChevronUp size={14} color="#4B5563" strokeWidth={2} style={{ marginTop: 3 }} />
                  ) : (
                    <ChevronDown size={14} color="#4B5563" strokeWidth={2} style={{ marginTop: 3 }} />
                  )}
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.dateTime}>
              <Text style={[styles.dateText, { color: '#6B7280' }]}>
                {formatMessageDate(email.receivedAt || email.receivedDate || email.createdAt)}
              </Text>
            </View>
          </View>

          {/* Email Details */}
          {showEmailDetails && (
            <View style={[styles.emailDetailsPanel, { borderColor: colors.border || colors.divider }]}>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>From</Text>
                <View style={styles.detailValue}>
                  <Text style={[styles.detailName, { color: colors.text }]}>{senderName}</Text>
                  <Text style={[styles.detailEmail, { color: colors.muted }]}>{senderEmail}</Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>To</Text>
                <Text style={[styles.detailEmail, { color: colors.text }]}>
                  {typeof email.to === 'string' ? email.to : formatRecipients(email.to)}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Date</Text>
                <Text style={[styles.detailEmail, { color: colors.text }]}>
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
                <Lock size={16} color={colors.muted} strokeWidth={2} />
                <View style={styles.detailValue}>
                  <Text style={[styles.detailEmail, { color: colors.text }]}>Standard encryption (TLS)</Text>
                </View>
              </View>
            </View>
          )}
        </View>

        {/* Attachments — Gmail-style cards in a horizontal rail with typed icons */}
        {email.attachments && email.attachments.length > 0 && (
          <View style={styles.attachmentsSection}>
            <View style={styles.attachmentsHeader}>
              <Paperclip size={13} color={colors.muted} strokeWidth={2} />
              <Text style={[styles.attachmentsHeaderText, { color: colors.muted }]}>
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
                      <Text style={[styles.attachmentCardSub, { color: colors.muted }]} numberOfLines={1}>
                        {[ext, attachment.size > 0 ? formatFileSize(attachment.size) : ''].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Download size={16} color={colors.muted} strokeWidth={2} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* Email Body */}
        <View style={styles.bodySection}>
          {(email.bodyHtml || email.htmlBody || email.htmlContent) ? (
            <EmailHtmlView
              html={email.bodyHtml || email.htmlBody || email.htmlContent}
              textColor={colors.text}
              fontSize={16}
              lineHeight={1.6}
              initialHeight={300}
              style={styles.webViewBody}
            />
          ) : (
            <Text style={[styles.body, { color: colors.text }]}>
              {email.textContent || email.body || email.preview || email.snippet || 'No content'}
            </Text>
          )}
        </View>

        {/* Thread messages */}
        {hasThread && (
          <View style={styles.threadSection}>
            <Text style={[styles.threadSectionLabel, { color: colors.muted }]}>
              {olderMessages.length} earlier {olderMessages.length === 1 ? 'message' : 'messages'}
            </Text>
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
      </ScrollView>

      {/* Action Bar */}
      <View style={[styles.actionBar, { backgroundColor: colors.background, paddingBottom: insets.bottom + 6 }]}>
        <TouchableOpacity
          style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
          activeOpacity={0.7}
          onPress={() => openCompose('reply')}
        >
          <Reply size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.replyText, { color: colors.text }]}>Reply</Text>
        </TouchableOpacity>
        {hasMultipleRecipients && (
          <TouchableOpacity
            style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
            activeOpacity={0.7}
            onPress={() => openCompose('replyAll')}
          >
            <ReplyAll size={16} color={colors.text} strokeWidth={2} />
            <Text style={[styles.replyText, { color: colors.text }]}>Reply All</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
          activeOpacity={0.7}
          onPress={() => openCompose('forward')}
        >
          <Forward size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.replyText, { color: colors.text }]}>Forward</Text>
        </TouchableOpacity>
      </View>

      <SnoozePickerModal
        visible={snoozePickerVisible}
        onClose={() => setSnoozePickerVisible(false)}
        onSelect={handleSnoozeSelect}
      />
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

const styles = StyleSheet.create({
  container: { flex: 1 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  emptyText: { fontSize: 16, fontWeight: '500' },
  errorText: { fontSize: 16 },
  fixedHeader: { paddingHorizontal: 20, paddingBottom: 8, borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB' },
  headerActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 16 },
  actionButton: { padding: 6 },
  scrollView: { flex: 1 },
  emailHeader: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 16 },
  subjectLine: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(128,128,128,0.2)' },
  subjectText: { fontSize: 22, fontWeight: '600', lineHeight: 28, flex: 1 },
  threadBadge: { backgroundColor: '#6B7280', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, minWidth: 24, alignItems: 'center' },
  threadBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  threadSection: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E7EB' },
  threadSectionLabel: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  threadCollapsed: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  threadAvatar: { width: 32, height: 32, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  threadAvatarText: { fontSize: 14, fontWeight: '600' },
  threadCollapsedContent: { flex: 1 },
  threadSenderName: { fontSize: 15, fontWeight: '600' },
  threadPreview: { fontSize: 14, marginTop: 2 },
  threadDate: { fontSize: 13 },
  threadExpanded: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10 },
  threadExpandedHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  threadExpandedSender: { flex: 1 },
  threadRecipientText: { fontSize: 13, marginTop: 2 },
  threadBody: { paddingLeft: 44, paddingRight: 8, paddingBottom: 6 },
  threadBodyText: { fontSize: 15, lineHeight: 22 },
  threadActions: { flexDirection: 'row', gap: 10, paddingLeft: 44, paddingTop: 6 },
  threadActionButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderRadius: 8 },
  threadActionText: { fontSize: 13, fontWeight: '500' },
  senderSection: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  senderAvatar: { width: 36, height: 36, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  senderAvatarText: { fontSize: 15, fontWeight: '600' },
  senderInfo: { flex: 1 },
  senderNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  senderNameText: { fontSize: 16, fontWeight: '600' },
  toMeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -2 },
  recipientLabel: { fontSize: 15, marginTop: 1 },
  dateTime: { alignItems: 'flex-end' },
  dateText: { fontSize: 14 },
  emailDetailsPanel: { marginTop: 14, borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 4 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: '#F3F4F6', gap: 12 },
  detailLabel: { fontSize: 14, fontWeight: '500', width: 44, paddingTop: 1 },
  detailValue: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  detailName: { fontSize: 15, fontWeight: '600' },
  detailEmail: { fontSize: 15 },
  attachmentsSection: { paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB' },
  attachmentsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  attachmentsHeaderText: { fontSize: 11, fontWeight: '500', letterSpacing: 0.8 },
  attachmentRail: { gap: 8, paddingRight: 20 },
  attachmentCard: {
    width: 210,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  attachmentCardIcon: { width: 36, height: 36, borderRadius: 9, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  attachmentCardMeta: { flex: 1, minWidth: 0 },
  attachmentCardName: { fontSize: 13, fontWeight: '500' },
  attachmentCardSub: { fontSize: 11, marginTop: 2 },
  bodySection: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  body: { fontSize: 16, lineHeight: 24 },
  webViewBody: { backgroundColor: 'transparent', opacity: 0.99 },
  // Floating Reply/Forward toolbar — elevated above the scrolling email (Outlook style).
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: 8,
    paddingHorizontal: 20,
    gap: 8,
    borderTopWidth: 0.5,
    borderTopColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 12,
  },
  replyButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 14, borderWidth: 1, borderRadius: 10, flex: 1 },
  replyText: { fontSize: 13, fontWeight: '600' },
});
