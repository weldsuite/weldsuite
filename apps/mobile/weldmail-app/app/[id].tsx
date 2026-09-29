import { styles } from './[id].styles';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
import { useObserve } from 'expo-observe';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Star,
  Reply,
  ReplyAll,
  Forward,
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
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { getMessage, markMessageRead, getThread } from '@/services/mail-tenant';
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
import { hideAppSplash } from '@/utils/splash';
import { firstParam, stubEmailFromTarget } from '@/utils/notification-target';
import { getNextVisibleMessageId } from '@/utils/next-email';
import CloseArchiveButtons from '@/components/CloseArchiveButtons';

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
  if (Number.isNaN(date.getTime())) return '';
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


function ThreadMessage({ message, colors, isExpanded, onToggle, onReply, onReplyAll, onForward, router }: Readonly<{
  message: any;
  colors: any;
  isExpanded: boolean;
  onToggle: () => void;
  onReply: (msg: any) => void;
  onReplyAll: (msg: any) => void;
  onForward: (msg: any) => void;
  router: any;
}>) {
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


const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isNotFoundError = (err: unknown) => isApiError(err) && err.status === 404;

// Fetch the message with a few retries. Only a genuine 404 means the
// message is really gone; a network drop, a not-yet-ready auth token, or
// a 5xx are transient and must NOT surface as "Email not found" — we
// retry, then fall back to a retryable error state.
async function fetchMessageWithRetry(
  id: string,
  isCancelled: () => boolean,
): Promise<{ fetched: any; gone: boolean }> {
  for (let attempt = 0; attempt < 3 && !isCancelled(); attempt++) {
    try {
      return { fetched: await getMessage(id), gone: false };
    } catch (err) {
      if (isNotFoundError(err)) return { fetched: null, gone: true };
      if (attempt < 2) await delay(300 * (attempt + 1));
    }
  }
  return { fetched: null, gone: false };
}

interface LoadEmailContext {
  id: string;
  cache: ReturnType<typeof useMailCache>;
  stub: any;
  isCancelled: () => boolean;
  setEmail: (email: any) => void;
  setThreadMessages: (messages: any[]) => void;
  setLoading: (loading: boolean) => void;
  setBodyLoading: (loading: boolean) => void;
  setLoadOutcome: (outcome: 'gone' | 'failed' | null) => void;
  refreshMail: () => void;
}

function showCachedEmail(ctx: LoadEmailContext, cachedMsg: any, cachedThread: any) {
  ctx.setEmail(cachedMsg);
  if (cachedThread) ctx.setThreadMessages((cachedThread as any[]).filter((m) => m.id !== ctx.id));
  ctx.setLoading(false);
  ctx.setBodyLoading(false);
}

function applyFetchResult(
  ctx: LoadEmailContext,
  { fetched, gone, hasCached }: { fetched: any; gone: boolean; hasCached: boolean },
) {
  if (fetched) {
    ctx.setEmail(fetched);
    ctx.setLoadOutcome(null);
    ctx.setBodyLoading(false);
    ctx.cache.setMessage(ctx.id, fetched as Record<string, unknown>);
    markMessageRead(ctx.id).catch(() => {});
    return;
  }
  // Nothing fetched and nothing to show.
  if (hasCached || ctx.stub) return;
  if (gone) {
    // Genuinely gone server-side. We had nothing cached, so the tapped row
    // was a stale/dead entry in the list — re-sync so it disappears.
    ctx.setLoadOutcome('gone');
    ctx.refreshMail();
  } else {
    // Couldn't reach it after retries and have nothing to show — offer a
    // retry instead of a misleading "not found".
    ctx.setLoadOutcome('failed');
  }
}

// Thread is best-effort and must never gate the message view.
async function loadThreadBestEffort(ctx: LoadEmailContext) {
  try {
    const t = await getThread(ctx.id);
    if (!ctx.isCancelled()) {
      ctx.cache.setThread(ctx.id, t);
      ctx.setThreadMessages(t.filter((m: { id: string }) => m.id !== ctx.id));
    }
  } catch {
    // Keep any cached thread already shown.
  }
}

async function loadEmail(ctx: LoadEmailContext) {
  const { id, cache, isCancelled } = ctx;
  // Cache-first: if we've opened this email before, show it (and its thread)
  // instantly, so a re-open works offline and there's no spinner online.
  const [cachedMsg, cachedThread] = await Promise.all([cache.getMessage(id), cache.getThread(id)]);
  if (isCancelled()) return;
  if (cachedMsg) showCachedEmail(ctx, cachedMsg, cachedThread);

  const { fetched, gone } = await fetchMessageWithRetry(id, isCancelled);
  if (isCancelled()) return;
  applyFetchResult(ctx, { fetched, gone, hasCached: !!cachedMsg });

  await loadThreadBestEffort(ctx);

  if (!isCancelled()) {
    ctx.setLoading(false);
    ctx.setBodyLoading(false);
  }
}

const countAddresses = (value: any): number => {
  const text = formatRecipients(value);
  return text ? text.split(/[,;]\s*/).filter(Boolean).length : 0;
};

// Reply All only makes sense with more than one recipient.
const hasMultipleRecipientsIn = (message: any): boolean =>
  countAddresses(message.to) + countAddresses(message.cc) > 1;

const emailDate = (email: any) => email.receivedAt || email.receivedDate || email.createdAt;

function formatDetailedDate(d: string | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })} ${date.getFullYear()} at ${time}`;
}

const HEADER_HIT_SLOP = { top: 6, bottom: 6, left: 6, right: 6 };

type ThemeColors = ReturnType<typeof useTheme>['colors'];

function EmailStatusFrame({ onClose, children }: Readonly<{ onClose: () => void; children: React.ReactNode }>) {
  const { theme, colors } = useTheme();
  const isDark = theme === 'dark';
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.topHeader,
          { paddingTop: insets.top, backgroundColor: colors.background, borderBottomColor: '#E5E7EB' },
        ]}
      >
        <View style={styles.topHeaderRow}>
          <CloseArchiveButtons
            onClose={onClose}
            onArchiveAndNext={() => {}}
            borderColor={isDark ? colors.border : '#E5E7EB'}
            iconColor={isDark ? colors.mutedForeground : '#6B7280'}
            archiveDisabled
          />
        </View>
      </View>
      <View style={styles.centerContainer}>{children}</View>
    </View>
  );
}

function EmailLoadingScreen({ onClose }: Readonly<{ onClose: () => void }>) {
  const { colors } = useTheme();
  return (
    <EmailStatusFrame onClose={onClose}>
      {/* ActivityIndicator animates on the UI thread, so it stays smooth even
          while the JS thread is busy with the navigation + fetch that opening
          an email kicks off (MaterialSpinner's SVG animation janks there). */}
      <ActivityIndicator size="large" color={colors.text} />
    </EmailStatusFrame>
  );
}

function EmailUnavailableScreen({ onClose, isGone, onRetry }: Readonly<{ onClose: () => void; isGone: boolean; onRetry: () => void }>) {
  const { colors } = useTheme();
  return (
    <EmailStatusFrame onClose={onClose}>
      <Text style={[styles.errorText, { color: colors.text }]}>
        {isGone ? 'Email not found' : "Couldn't load this email"}
      </Text>
      {!isGone && (
        <TouchableOpacity
          onPress={onRetry}
          style={{ marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: '#4D94F8' }}
          activeOpacity={0.7}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>Retry</Text>
        </TouchableOpacity>
      )}
    </EmailStatusFrame>
  );
}

function HeaderIconButton({ onPress, children }: Readonly<{ onPress: () => void; children: React.ReactNode }>) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.topHeaderIconBtn} hitSlop={HEADER_HIT_SLOP}>
      {children}
    </TouchableOpacity>
  );
}

interface EmailTopHeaderProps {
  email: any;
  isPinned: boolean;
  isDark: boolean;
  colors: ThemeColors;
  topInset: number;
  onContinueToNext: () => void;
  onArchiveAndNext: () => void;
  onStar: () => void;
  onPin: () => void;
  onArchive: () => void;
  onSnooze: () => void;
  onLabels: () => void;
  onMore: () => void;
}

// Top Header Bar — subject inline + actions
function EmailTopHeader({
  email,
  isPinned,
  isDark,
  colors,
  topInset,
  onContinueToNext,
  onArchiveAndNext,
  onStar,
  onPin,
  onArchive,
  onSnooze,
  onLabels,
  onMore,
}: Readonly<EmailTopHeaderProps>) {
  const starColor = email.isStarred ? '#EAB308' : '#6B7280';
  const pinColor = isPinned ? '#3B82F6' : '#6B7280';

  return (
    <View
      style={[
        styles.topHeader,
        {
          paddingTop: topInset,
          backgroundColor: colors.background,
          borderBottomColor: '#E5E7EB',
        },
      ]}
    >
      <View style={styles.topHeaderRow}>
        <CloseArchiveButtons
          onClose={onContinueToNext}
          onArchiveAndNext={onArchiveAndNext}
          borderColor={isDark ? colors.border : '#E5E7EB'}
          iconColor={isDark ? colors.mutedForeground : '#6B7280'}
        />
        <View style={{ flex: 1 }} />
        <View style={styles.topHeaderActions}>
          <HeaderIconButton onPress={onStar}>
            <Star
              size={18}
              color={starColor}
              fill={email.isStarred ? '#EAB308' : 'transparent'}
              strokeWidth={2}
            />
          </HeaderIconButton>
          <HeaderIconButton onPress={onPin}>
            <Pin
              size={18}
              color={pinColor}
              fill={isPinned ? '#3B82F6' : 'transparent'}
              strokeWidth={2}
            />
          </HeaderIconButton>
          <HeaderIconButton onPress={onArchive}>
            <Archive size={18} color="#6B7280" strokeWidth={2} />
          </HeaderIconButton>
          <HeaderIconButton onPress={onSnooze}>
            <Clock size={18} color="#6B7280" strokeWidth={2} />
          </HeaderIconButton>
          <HeaderIconButton onPress={onLabels}>
            <Tag size={18} color="#6B7280" strokeWidth={2} />
          </HeaderIconButton>
          <HeaderIconButton onPress={onMore}>
            <MoreVertical size={18} color="#6B7280" strokeWidth={2} />
          </HeaderIconButton>
        </View>
      </View>
    </View>
  );
}

interface EmailSenderHeaderProps {
  email: any;
  senderName: string;
  avatarColor: string;
  showEmailDetails: boolean;
  colors: ThemeColors;
  onOpenContact: () => void;
  onToggleDetails: () => void;
}

// Sender Header — avatar | name to email | date · more
function EmailSenderHeader({ email, senderName, avatarColor, showEmailDetails, colors, onOpenContact, onToggleDetails }: Readonly<EmailSenderHeaderProps>) {
  const DetailsChevron = showEmailDetails ? ChevronUp : ChevronDown;

  return (
    <View style={styles.senderHeader}>
      <View style={styles.senderLeft}>
        <TouchableOpacity onPress={onOpenContact} activeOpacity={0.7}>
          <View style={[styles.senderAvatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.senderAvatarText}>
              {senderName.charAt(0).toUpperCase()}
            </Text>
          </View>
        </TouchableOpacity>
        <View style={styles.senderInfo}>
          <View style={styles.senderLineWrap}>
            <TouchableOpacity onPress={onOpenContact} activeOpacity={0.7}>
              <Text style={[styles.senderName, { color: colors.text }]} numberOfLines={1}>
                {senderName}
              </Text>
            </TouchableOpacity>
            <Text style={styles.senderToWord}>to</Text>
            <TouchableOpacity
              onPress={onToggleDetails}
              activeOpacity={0.7}
              style={styles.senderRecipientWrap}
            >
              <Text style={styles.senderRecipientEmail} numberOfLines={1}>
                {formatRecipients(email.to) || 'me'}
              </Text>
              <DetailsChevron size={13} color="#3B82F6" strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
      <Text style={styles.senderDate}>
        {formatPlatformDate(emailDate(email))}
      </Text>
    </View>
  );
}

// Email Details Panel
function EmailDetailsPanel({ email, senderName, senderEmail, colors }: Readonly<{ email: any; senderName: string; senderEmail: string; colors: ThemeColors }>) {
  return (
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
          {formatRecipients(email.to)}
        </Text>
      </View>
      <View style={styles.detailRow}>
        <Text style={styles.detailLabel}>Date</Text>
        <Text style={[styles.detailEmailLine, { color: colors.text }]}>
          {formatDetailedDate(emailDate(email))}
        </Text>
      </View>
      <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
        <Lock size={14} color="#6B7280" strokeWidth={2} style={{ marginTop: 2 }} />
        <Text style={[styles.detailEmailLine, { color: colors.text, marginLeft: 6 }]}>
          Standard encryption (TLS)
        </Text>
      </View>
    </View>
  );
}

function EmailBody({ email, bodyLoading, colors }: Readonly<{ email: any; bodyLoading: boolean; colors: ThemeColors }>) {
  const html = email.bodyHtml || email.htmlBody || email.htmlContent;
  if (html) {
    return (
      <EmailHtmlView
        html={html}
        fontSize={14}
        lineHeight={1.625}
        initialHeight={300}
        style={styles.webViewBody}
      />
    );
  }
  if (bodyLoading) {
    return (
      <View style={{ paddingVertical: 32, alignItems: 'center' }}>
        <ActivityIndicator size="small" color={colors.text} />
      </View>
    );
  }
  return (
    <Text style={[styles.body, { color: colors.text }]}>
      {email.textBody || email.textContent || email.body || email.preview || email.snippet || 'No content'}
    </Text>
  );
}

const attachmentName = (attachment: any): string =>
  attachment.fileName || attachment.filename || attachment.name || 'Attachment';

function AttachmentCard({ attachment, colors, isDark }: Readonly<{ attachment: any; colors: ThemeColors; isDark: boolean }>) {
  const name = attachmentName(attachment);
  const { kind, color, ext } = getAttachmentVisual(name);
  const Icon = ATTACHMENT_ICONS[kind];
  const sizeLabel = attachment.size > 0 ? formatFileSize(attachment.size) : '';

  return (
    <TouchableOpacity
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
          {[ext, sizeLabel].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Download size={16} color="#9CA3AF" strokeWidth={2} />
    </TouchableOpacity>
  );
}

// Attachments — Gmail-style cards in a horizontal rail with typed icons
function AttachmentsBlock({ attachments, colors, isDark }: Readonly<{ attachments: any[]; colors: ThemeColors; isDark: boolean }>) {
  return (
    <View style={styles.attachmentsBlock}>
      <View style={styles.attachmentsHeader}>
        <Paperclip size={13} color="#6B7280" strokeWidth={2} />
        <Text style={styles.attachmentsHeaderText}>
          {attachments.length} {attachments.length === 1 ? 'ATTACHMENT' : 'ATTACHMENTS'}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.attachmentRail}
      >
        {attachments.map((attachment) => (
          <AttachmentCard
            key={attachment.id || attachmentName(attachment)}
            attachment={attachment}
            colors={colors}
            isDark={isDark}
          />
        ))}
      </ScrollView>
    </View>
  );
}

interface ActionBarButtonProps {
  label: string;
  isDark: boolean;
  colors: ThemeColors;
  onPress: () => void;
  children: React.ReactNode;
}

function ActionBarButton({ label, isDark, colors, onPress, children }: Readonly<ActionBarButtonProps>) {
  return (
    <TouchableOpacity
      style={[
        styles.actionBarBtn,
        {
          backgroundColor: isDark ? '#1F1F23' : '#FFFFFF',
          borderColor: isDark ? '#3F3F46' : '#E5E7EB',
        },
      ]}
      activeOpacity={0.7}
      onPress={onPress}
    >
      {children}
      <Text style={[styles.actionBarText, { color: colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

interface EmailActionBarProps {
  hasMultipleRecipients: boolean;
  isDark: boolean;
  colors: ThemeColors;
  bottomInset: number;
  onCompose: (mode: 'reply' | 'replyAll' | 'forward') => void;
}

// Gmail-style fixed action bar
function EmailActionBar({ hasMultipleRecipients, isDark, colors, bottomInset, onCompose }: Readonly<EmailActionBarProps>) {
  return (
    <View
      style={[
        styles.actionBar,
        {
          paddingBottom: bottomInset + 6,
          backgroundColor: colors.background,
          borderTopColor: colors.border || colors.divider || '#E5E7EB',
        },
      ]}
    >
      <ActionBarButton label="Reply" isDark={isDark} colors={colors} onPress={() => onCompose('reply')}>
        <Reply size={16} color={colors.text} strokeWidth={2} />
      </ActionBarButton>
      {hasMultipleRecipients && (
        <ActionBarButton label="Reply all" isDark={isDark} colors={colors} onPress={() => onCompose('replyAll')}>
          <ReplyAll size={16} color={colors.text} strokeWidth={2} />
        </ActionBarButton>
      )}
      <ActionBarButton label="Forward" isDark={isDark} colors={colors} onPress={() => onCompose('forward')}>
        <Forward size={16} color={colors.text} strokeWidth={2} />
      </ActionBarButton>
    </View>
  );
}

function showMoreMenu(onAction: (buttonIndex: number) => void) {
  const options = ['Mark as unread', 'Delete', 'Mark as spam', 'Report phishing', 'Cancel'];
  const cancelButtonIndex = options.length - 1;
  const destructiveButtonIndex = [1, 2]; // Delete + Mark as spam

  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex, destructiveButtonIndex },
      (buttonIndex) => onAction(buttonIndex),
    );
  } else {
    Alert.alert('Actions', undefined, [
      { text: 'Mark as unread', onPress: () => onAction(0) },
      { text: 'Delete', style: 'destructive', onPress: () => onAction(1) },
      { text: 'Mark as spam', style: 'destructive', onPress: () => onAction(2) },
      { text: 'Report phishing', onPress: () => onAction(3) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }
}

interface EmailDetailContentProps {
  email: any;
  setEmail: (email: any) => void;
  threadMessages: any[];
  bodyLoading: boolean;
  currentId: string | undefined;
  goBack: () => void;
}

function EmailDetailContent({ email, setEmail, threadMessages, bodyLoading, currentId, goBack }: Readonly<EmailDetailContentProps>) {
  const { theme, colors } = useTheme();
  const isDark = theme === 'dark';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { refreshMail, accounts } = useMail();
  const outbox = useMailOutbox();
  const { isPinned: isMessagePinned, togglePin } = usePinnedMessages();
  const { openCompose: openComposeOverlay } = useComposeOverlay();

  const [showEmailDetails, setShowEmailDetails] = useState(false);
  const [, setIsScrolled] = useState(false);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(new Set());
  const [snoozePickerVisible, setSnoozePickerVisible] = useState(false);
  const [labelPickerVisible, setLabelPickerVisible] = useState(false);

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
    const wasStarred = email.isStarred;
    setEmail({ ...email, isStarred: !wasStarred });
    // Durable + offline-safe: queues the change and flushes when online. Never
    // throws on a connectivity failure, so the optimistic star stays put.
    await outbox.update(email.id, { isStarred: !wasStarred });
    refreshMail();
  };

  // Pin is client-side only (no backend field) — toggle it in the shared
  // PinnedMessages context so the inbox reflects it too.
  const handlePinToggle = () => togglePin(email.id);

  const handleDelete = useCallback(async () => {
    // Queue the delete (replays on reconnect) and leave — the inbox overlay
    // hides it immediately, online or off.
    await outbox.remove(email.id);
    refreshMail();
    goBack();
  }, [email, outbox, refreshMail, goBack]);

  const handleArchive = async () => {
    await outbox.archive(email.id);
    refreshMail();
    goBack();
  };

  const goToNextOrBack = useCallback((fromId: string) => {
    const nextId = getNextVisibleMessageId(fromId);
    if (nextId) router.replace(`/${nextId}` as any);
    else goBack();
  }, [goBack, router]);

  // Check: archive this conversation and open the next row (web archive-and-next).
  const handleArchiveAndNext = useCallback(async () => {
    const fromId = email.id;
    await outbox.archive(fromId);
    refreshMail();
    goToNextOrBack(fromId);
  }, [email, goToNextOrBack, outbox, refreshMail]);

  // X: leave this conversation in the inbox and open the next one.
  const handleContinueToNext = useCallback(() => {
    goToNextOrBack(email.id);
  }, [email, goToNextOrBack]);

  const handleMarkAsUnread = useCallback(async () => {
    await outbox.update(email.id, { isRead: false });
    refreshMail();
    goBack();
  }, [email, goBack, refreshMail, outbox]);

  const handleMoreMenuAction = useCallback((buttonIndex: number) => {
    switch (buttonIndex) {
      case 0: // Mark as unread
        handleMarkAsUnread();
        break;
      case 1: // Delete
        handleDelete();
        break;
      case 2: // Mark as spam
        outbox.update(email.id, { isSpam: true }).then(() => { refreshMail(); goBack(); });
        break;
      case 3: // Report phishing
        outbox.update(email.id, { isSpam: true }).then(() => {
          refreshMail();
          Alert.alert('Reported', 'This message has been reported as phishing.');
          goBack();
        });
        break;
      default:
        break;
    }
  }, [email, goBack, handleMarkAsUnread, handleDelete, refreshMail, outbox]);

  const handleSnoozeSelect = useCallback(async (until: string, _label: string) => {
    setSnoozePickerVisible(false);
    const accountId = email.accountId || '';
    await outbox.snooze(email.id, accountId, until);
    refreshMail();
    goBack();
  }, [email, goBack, refreshMail, outbox]);

  const handleLabelsChanged = useCallback((newLabels: string[]) => {
    setEmail({ ...email, labels: newLabels });
    refreshMail();
  }, [email, refreshMail, setEmail]);

  const openComposeForMessage = (msg: any, mode: 'reply' | 'replyAll' | 'forward') => {
    openComposeOverlay(
      buildComposeParams(
        msg,
        mode,
        email?.emailAccountId || email?.accountId || '',
        accounts.map((a) => a.emailAddress),
      ),
    );
  };

  const senderName = getSenderName(email.from) || email.fromName || 'Unknown';
  const senderEmail = email.fromEmail || getSenderEmail(email.from);
  const avatarColor = getInitialColor(senderName);
  const openContact = () => router.push(`/contact/${encodeURIComponent(senderEmail || senderName)}` as any);

  // Older thread messages (everything except current email, newest first below)
  const olderMessages = threadMessages.filter(m => m.id !== currentId).reverse();
  const hasThread = olderMessages.length > 0;
  const threadCount = olderMessages.length + 1; // Include current message
  const hasAttachments = !!email.attachments?.length;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <EmailTopHeader
        email={email}
        isPinned={isMessagePinned(email.id)}
        isDark={isDark}
        colors={colors}
        topInset={insets.top}
        onContinueToNext={handleContinueToNext}
        onArchiveAndNext={handleArchiveAndNext}
        onStar={handleStarToggle}
        onPin={handlePinToggle}
        onArchive={handleArchive}
        onSnooze={() => setSnoozePickerVisible(true)}
        onLabels={() => setLabelPickerVisible(true)}
        onMore={() => showMoreMenu(handleMoreMenuAction)}
      />

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

        <EmailSenderHeader
          email={email}
          senderName={senderName}
          avatarColor={avatarColor}
          showEmailDetails={showEmailDetails}
          colors={colors}
          onOpenContact={openContact}
          onToggleDetails={() => setShowEmailDetails(!showEmailDetails)}
        />

        {showEmailDetails && (
          <EmailDetailsPanel email={email} senderName={senderName} senderEmail={senderEmail} colors={colors} />
        )}

        {/* Email Body */}
        <View style={styles.bodySection}>
          <EmailBody email={email} bodyLoading={bodyLoading} colors={colors} />
        </View>

        {hasAttachments && <AttachmentsBlock attachments={email.attachments} colors={colors} isDark={isDark} />}

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

      <EmailActionBar
        hasMultipleRecipients={hasMultipleRecipientsIn(email)}
        isDark={isDark}
        colors={colors}
        bottomInset={insets.bottom}
        onCompose={(mode) => openComposeForMessage(email, mode)}
      />

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

export default function EmailDetailScreen() {
  const params = useLocalSearchParams<{
    id: string;
    fromName?: string;
    fromEmail?: string;
    subject?: string;
    preview?: string;
    fromNotification?: string;
  }>();
  const id = firstParam(params.id);
  const fromName = firstParam(params.fromName);
  const fromEmail = firstParam(params.fromEmail);
  const subject = firstParam(params.subject);
  const preview = firstParam(params.preview);
  const router = useRouter();
  const { markInteractive } = useObserve();
  const { organizationId } = useClerkAuth();
  const { refreshMail } = useMail();
  const cache = useMailCache();

  const stub = useMemo(
    () => (id ? stubEmailFromTarget(id, { fromName, fromEmail, subject, preview }) : null),
    [id, fromName, fromEmail, subject, preview],
  );

  const [email, setEmail] = useState<any>(stub);
  const [threadMessages, setThreadMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(!stub);
  const [bodyLoading, setBodyLoading] = useState(true);
  // How the message load ended when there's nothing to show: a real 404 (the
  // message is genuinely gone) vs a transient failure (offline / token not
  // ready / 5xx) that a Retry can recover. Keeps a network blip from lying
  // "Email not found".
  const [loadOutcome, setLoadOutcome] = useState<'gone' | 'failed' | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadOutcome(null);
    loadEmail({
      id,
      cache,
      stub,
      isCancelled: () => cancelled,
      setEmail,
      setThreadMessages,
      setLoading,
      setBodyLoading,
      setLoadOutcome,
      refreshMail,
    });
    return () => {
      cancelled = true;
    };
  }, [id, cache, reloadTick, organizationId, refreshMail, stub]);

  const retryLoad = useCallback(() => {
    setLoading(true);
    setLoadOutcome(null);
    setReloadTick((t) => t + 1);
  }, []);

  if (loading && !email) return <EmailLoadingScreen onClose={goBack} />;

  if (!email) {
    // A real 404 → the message is gone. Anything else (offline / token / 5xx)
    // is transient and gets a Retry rather than a false "not found".
    return <EmailUnavailableScreen onClose={goBack} isGone={loadOutcome === 'gone'} onRetry={retryLoad} />;
  }

  return (
    <EmailDetailContent
      email={email}
      setEmail={setEmail}
      threadMessages={threadMessages}
      bodyLoading={bodyLoading}
      currentId={id}
      goBack={goBack}
    />
  );
}
