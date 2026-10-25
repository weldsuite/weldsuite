import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  Clipboard,
  Modal,
  Pressable,
  Alert,
  ActivityIndicator,
  ScrollView,
  Keyboard,
  Linking,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useOrganization, useAuth, useUser } from '@clerk/expo';
import { useObserve } from 'expo-observe';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring, withTiming, interpolate, Extrapolation } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Gesture, GestureDetector, FlatList } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';

import { Archive, Bell, BellOff, ChevronDown, ChevronLeft, Clock, FileText, Hash, Infinity as InfinityIcon, Lock, MessageSquare, Pencil, Phone, PhoneMissed, Reply, Video, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { randomUUID } from 'expo-crypto';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ACCENTS, BRAND } from '@/lib/brand';
import { useI18n, type Translations } from '@/lib/i18n';

import type { ThemeColors } from '@/lib/theme-colors';

import { VideoCameraIcon } from '@/components/icons/VideoCameraIcon';
import { useCall } from '@/contexts/CallContext';
import { useChatRealtime } from '@/hooks/useChatRealtime';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { openExternalUrl } from '@/utils/safe-url';
import { hideAppSplash } from '@/utils/splash';
import { ReactionBar } from './ReactionBar';
import { MessageActions } from './MessageActions';
import { EmojiPicker } from './EmojiPicker';
import { MentionPicker } from './MentionPicker';
import { renderMessageText } from './MessageText';
import { AudioPlayer } from './AudioPlayer';
import { ImageViewer } from './ImageViewer';
import {
  CollapsedComposer,
  ComposerBarFrame,
  ExpandedComposer,
  PendingFiles,
  RecordingPill,
  useComposerBarStyle,
  useKeyboardHide,
  type ExpandedComposerProps,
} from './ComposerBar';
import {
  MIN_VOICE_MESSAGE_MS,
  openAttachmentPicker,
  uploadChatAttachment,
  type ChatAttachment,
  type RNFile,
} from '@/lib/chat/attachments';
import { appApi, appApiClient } from '@/services/app-api';
import {
  detectMentionQuery,
  insertMention,
  mentionsToPlainText,
} from '@/lib/chat/mentions';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

type Styles = ReturnType<typeof makeStyles>;

interface Message {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  type?: string;
  reactions?: Record<string, string[]>;
  threadReplyCount?: number;
  isPinned?: boolean;
  parentId?: string;
  attachments?: ChatAttachment[];
  hasAttachments?: boolean;
  metadata?: { replyTo?: ChatReplyReference } | null;
  /** Optimistic row shown while the send request is in flight. */
  pending?: boolean;
}

/**
 * Discord-style inline reply reference, built by the server from `replyToId`
 * and stored at `metadata.replyTo`. `depth` is the reply's position in the
 * chain, `rootId` the message that started it.
 */
interface ChatReplyReference {
  messageId: string;
  rootId: string;
  depth: number;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  content: string;
  hasAttachments?: boolean;
}

/** The message the composer is replying to. */
interface ReplyTarget {
  messageId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  content: string;
  /** Files only, no text: the reply bar previews it as "Attachment". */
  hasAttachments?: boolean;
  /** Chain depth of the target itself (0 for a plain message). */
  depth: number;
  rootId: string;
}

/** `reactions` with `userId` added to or removed from `emoji`. */
function withReaction(
  reactions: Record<string, string[]> | undefined,
  emoji: string,
  userId: string,
  add: boolean,
): Record<string, string[]> {
  const next = { ...reactions };
  const users = next[emoji] ?? [];
  if (add) {
    if (!users.includes(userId)) next[emoji] = [...users, userId];
  } else {
    const rest = users.filter((u) => u !== userId);
    if (rest.length > 0) next[emoji] = rest;
    else delete next[emoji];
  }
  return next;
}

/**
 * Replying to a message that is already this deep in a reply chain (the new
 * message would be the 4th in it) suggests moving the conversation to a
 * thread, like Discord does.
 */
const THREAD_SUGGESTION_DEPTH = 2;

function replyTargetFor(message: Message): ReplyTarget {
  const ref = message.metadata?.replyTo;
  return {
    messageId: message.id,
    authorId: message.authorId,
    authorName: message.authorName,
    authorAvatar: message.authorAvatar ?? null,
    content: message.content,
    hasAttachments: !!message.hasAttachments || (message.attachments?.length ?? 0) > 0,
    depth: ref?.depth ?? 0,
    rootId: ref?.rootId ?? message.id,
  };
}

/**
 * Author name for an optimistic message: the member directory entry, else the
 * first non-empty fallback (signed-in user's name, their last message's name).
 */
function optimisticAuthorName(
  userId: string | null | undefined,
  membersMap: Map<string, string>,
  fallbacks: ReadonlyArray<string | null | undefined>,
  youLabel: string,
): string {
  const memberName = userId ? membersMap.get(userId) : undefined;
  return memberName || fallbacks.find(Boolean) || youLabel;
}

/** `metadata.replyTo` for an optimistic reply, mirroring what the server stores. */
function optimisticReplyMetadata(reply: ReplyTarget | null): Message['metadata'] {
  if (!reply) return null;
  return {
    replyTo: {
      messageId: reply.messageId,
      rootId: reply.rootId,
      depth: reply.depth + 1,
      authorId: reply.authorId,
      authorName: reply.authorName,
      authorAvatar: reply.authorAvatar,
      content: reply.content,
    },
  };
}

/**
 * A call event the server posts as a `type: 'system'` message. Every call gets
 * two: "<name> started a voice/video call" when it starts, then "Call ended —
 * 2m 34s", "Call ended" or "Missed call" when it ends.
 */
type CallEvent =
  | { kind: 'start'; isVideo: boolean }
  | { kind: 'ended' | 'missed'; isVideo: boolean; duration?: string };

function parseCallEvent(content: string): CallEvent | null {
  const text = content.toLowerCase();
  const isVideo = text.includes('video call');
  if (text.startsWith('missed') && text.endsWith('call')) return { kind: 'missed', isVideo };
  if (text.startsWith('call ended')) {
    return { kind: 'ended', isVideo, duration: content.split('—')[1]?.trim() || undefined };
  }
  if (/ started an? (voice |video )?call$/.test(text)) return { kind: 'start', isVideo };
  return null;
}

/** One call in the conversation, shown as a single card. */
interface CallLogEntry {
  /** Unknown while the call runs, or when its end is not loaded. */
  outcome: 'ended' | 'missed' | null;
  isVideo: boolean;
  duration?: string;
  callerId: string;
  callerName: string;
  callerAvatar?: string;
}

/**
 * Pair each call's start and end messages. The card sits where the call
 * started; the end message folds into it. Calls in one conversation never
 * overlap, so an end belongs to the start before it. An end whose start is
 * on an older page stands on its own until that page loads.
 */
function buildCallLog(chronological: Message[]): {
  entries: Map<string, CallLogEntry>;
  folded: Set<string>;
  /** The newest start with no end yet: the call that may still be running. */
  openId: string | null;
} {
  const entries = new Map<string, CallLogEntry>();
  const folded = new Set<string>();
  let openId: string | null = null;
  for (const m of chronological) {
    if (m.type !== 'system') continue;
    const event = parseCallEvent(m.content);
    if (!event) continue;
    if (event.kind === 'start') {
      entries.set(m.id, {
        outcome: null,
        isVideo: event.isVideo,
        callerId: m.authorId,
        callerName: m.authorName,
        callerAvatar: m.authorAvatar,
      });
      openId = m.id;
      continue;
    }
    const start = openId ? entries.get(openId) : undefined;
    if (openId && start) {
      entries.set(openId, { ...start, outcome: event.kind, duration: event.duration });
      folded.add(m.id);
      openId = null;
    } else {
      entries.set(m.id, {
        outcome: event.kind,
        isVideo: event.isVideo,
        duration: event.duration,
        callerId: m.authorId,
        callerName: m.authorName,
        callerAvatar: m.authorAvatar,
      });
    }
  }
  return { entries, folded, openId };
}

/** Whether `item` opens a new calendar day relative to the chronologically previous message. */
function startsNewDay(item: Message, prev: Message | undefined): boolean {
  if (!prev) return true;
  const itemDate = new Date(item.createdAt);
  const prevDate = new Date(prev.createdAt);
  return (
    itemDate.getDate() !== prevDate.getDate() ||
    itemDate.getMonth() !== prevDate.getMonth() ||
    itemDate.getFullYear() !== prevDate.getFullYear()
  );
}

/** Consecutive messages by one author within five minutes collapse to a compact row. */
function isCompactMessage(item: Message, prev: Message | undefined): boolean {
  if (!prev) return false;
  const timeDiff = new Date(item.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return (
    prev.type !== 'system' &&
    prev.authorId === item.authorId &&
    !item.parentId &&
    // A reply always shows its full header, with the quote above it.
    !item.metadata?.replyTo &&
    !Number.isNaN(timeDiff) &&
    timeDiff >= 0 &&
    timeDiff < 300000
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Wraps a message row to add WhatsApp-style drag-right-to-reply.
 * Composes a LongPress (existing action sheet) with a Pan that activates
 * only on horizontal right motion; vertical motion yields to FlatList scroll
 * and left motion is ignored.
 */
function SwipeableMessage({
  onLongPress,
  onSwipeReply,
  highlighted,
  flashing,
  compact,
  children,
}: Readonly<{
  onLongPress: () => void;
  onSwipeReply: () => void;
  /** Being replied to: tinted the full width, as in Discord. */
  highlighted?: boolean;
  /** Just jumped to from a reply: the same tint, fading out slowly. */
  flashing?: boolean;
  /** A follow-up row in a group (no author line, small top gap). */
  compact?: boolean;
  children: React.ReactNode;
}>) {
  const { colors, theme } = useTheme();
  const translateX = useSharedValue(0);
  const crossedThreshold = useSharedValue(false);
  // Press-and-hold highlight: a soft area behind the message. It only appears
  // once a long-press actually activates (when the actions menu opens) — a
  // single tap/click never shows it — and always fades back out on release.
  const pressed = useSharedValue(0);
  const TRIGGER = 60;
  const MAX = 90;

  const fireHaptic = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const fireReply = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSwipeReply();
  };

  const longPress = Gesture.LongPress()
    .minDuration(450)
    .maxDistance(10)
    .onStart(() => {
      pressed.value = withTiming(1, { duration: 120 });
      scheduleOnRN(onLongPress);
    })
    .onFinalize(() => {
      pressed.value = withTiming(0, { duration: 180 });
    });

  const pan = Gesture.Pan()
    .activeOffsetX([-9999, 15])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      const next = Math.max(0, Math.min(MAX, e.translationX));
      const past = next >= TRIGGER;
      if (past && !crossedThreshold.value) {
        crossedThreshold.value = true;
        scheduleOnRN(fireHaptic);
      } else if (!past && crossedThreshold.value) {
        crossedThreshold.value = false;
      }
      translateX.value = next;
    })
    .onEnd(() => {
      if (crossedThreshold.value) {
        scheduleOnRN(fireReply);
      }
      crossedThreshold.value = false;
      translateX.value = withSpring(0, { damping: 18, stiffness: 240, mass: 0.7 });
    });

  const composed = Gesture.Race(longPress, pan);

  const messageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const highlightStyle = useAnimatedStyle(() => ({ opacity: pressed.value }));

  const iconStyle = useAnimatedStyle(() => {
    const progress = interpolate(
      Math.abs(translateX.value),
      [0, TRIGGER],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const past = translateX.value >= TRIGGER ? 1 : 0;
    return {
      opacity: progress,
      transform: [
        // The icon trails the message in from the left edge.
        { translateX: Math.min(MAX, translateX.value) - 44 },
        { scale: 0.5 + progress * 0.5 + past * 0.1 },
      ],
    };
  });

  return (
    <GestureDetector gesture={composed}>
      <View>
        {(highlighted || flashing) && (
          <Animated.View
            pointerEvents="none"
            entering={FadeIn.duration(150)}
            exiting={FadeOut.duration(flashing ? 700 : 150)}
            style={[
              swipeReplyStyles.pressHighlight,
              // Even space above the author line and below the text: a full
              // row's 12pt top margin is mostly left out of the band.
              !compact && swipeReplyStyles.replyTargetBand,
              { backgroundColor: theme === 'dark' ? REPLY_TARGET_TINT.dark : REPLY_TARGET_TINT.light },
            ]}
          />
        )}
        <Animated.View
          pointerEvents="none"
          style={[swipeReplyStyles.pressHighlight, { backgroundColor: colors.cardBackground }, highlightStyle]}
        />
        <Animated.View pointerEvents="none" style={[swipeReplyStyles.iconWrap, iconStyle]}>
          <View style={[swipeReplyStyles.iconBubble, { backgroundColor: colors.cardBackground }]}>
            <Reply size={20} color={colors.text} strokeWidth={2} />
          </View>
        </Animated.View>
        <Animated.View style={messageStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

/** How long a message jumped to from a reply stays tinted, before fading. */
const JUMP_FLASH_MS = 1800;

// Discord's blurple, faint, behind the message being replied to.
const REPLY_TARGET_TINT = { light: 'rgba(88, 101, 242, 0.12)', dark: 'rgba(88, 101, 242, 0.24)' };

const swipeReplyStyles = StyleSheet.create({
  pressHighlight: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    // Extend past the list's 16px horizontal padding to span the full screen
    // width, with square corners.
    left: -16,
    right: -16,
    borderRadius: 0,
  },
  replyTargetBand: { top: 6, bottom: -6 },
  iconWrap: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

function hasSendableContent(input: string, files: RNFile[]): boolean {
  return input.trim().length > 0 || files.length > 0;
}

/** Whether a reply/edit/file/typing row sits above the composer divider. */
function hasComposerContext(ctx: {
  editing: boolean;
  fileCount: number;
  typingCount: number;
}): boolean {
  return ctx.editing || ctx.fileCount > 0 || ctx.typingCount > 0;
}

/** Index of the pinned message currently shown (cycles through the pins). */
function pinnedPositionFor(index: number, count: number): number {
  return count > 0 ? index % count : 0;
}

type ActiveCall = NonNullable<ReturnType<typeof useCall>['activeChannelCalls'][string]>;
type ImageOrigin = { x: number; y: number; width: number; height: number };
type OpenImage = (url: string, origin: ImageOrigin | null) => void;
type MeasurableTarget = {
  measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
} | null;

function SystemMessage({ content, styles }: Readonly<{ content: string; styles: Styles }>) {
  return (
    <View style={styles.systemMessage}>
      <Text style={styles.systemText}>{content}</Text>
    </View>
  );
}

const DURATION_UNIT_SECONDS: Record<string, number> = { m: 60, s: 1 };

/** The server's "2m 34s" / "2m" / "45s" as seconds; null when there is none. */
function callDurationSeconds(duration: string | undefined): number | null {
  let total: number | null = null;
  for (const part of duration?.split(' ') ?? []) {
    const amount = Number.parseInt(part, 10);
    const unit = DURATION_UNIT_SECONDS[part.at(-1) ?? ''];
    if (Number.isNaN(amount) || !unit) continue;
    total = (total ?? 0) + amount * unit;
  }
  return total;
}

/**
 * A call in the conversation, as Discord draws it: a gray card with the call's
 * icon, how it went, how long it lasted and when, and the caller's avatar.
 * A call still running offers "Join" in place of the avatar.
 */
function CallLogCard({
  entry,
  ongoing,
  joinable,
  createdAt,
  colors,
  styles,
  onJoin,
}: Readonly<{
  entry: CallLogEntry;
  ongoing: boolean;
  /** Running and you are not in it. */
  joinable: boolean;
  createdAt: string;
  colors: ThemeColors;
  styles: Styles;
  onJoin: (callType: 'voice' | 'video') => void;
}>) {
  const { t, plural, intlLocale } = useI18n();
  const missed = entry.outcome === 'missed';

  let title = t.channel.callStarted;
  if (ongoing) title = t.channel.callOngoing;
  else if (missed) title = t.channel.missedCall;
  else if (entry.outcome === 'ended') title = t.channel.callEnded;

  const seconds = callDurationSeconds(entry.duration);
  let lasted: string | null = null;
  if (seconds !== null && seconds < 60) lasted = t.channel.callFewSeconds;
  else if (seconds !== null && seconds < 3600) lasted = plural(Math.round(seconds / 60), t.channel.callMinutes);
  else if (seconds !== null) lasted = plural(Math.round(seconds / 3600), t.channel.callHours);
  const when = new Date(createdAt).toLocaleString(intlLocale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  let iconColor = colors.mutedForeground;
  if (missed) iconColor = colors.destructive;
  else if (ongoing) iconColor = BRAND;
  // The app's call icons, solid, as the call events always used.
  let icon = <Phone size={20} color={iconColor} fill={iconColor} strokeWidth={2} />;
  if (missed) icon = <PhoneMissed size={20} color={iconColor} fill={iconColor} strokeWidth={2} />;
  else if (entry.isVideo) icon = <VideoCameraIcon size={22} color={iconColor} fill={iconColor} strokeWidth={2} />;

  return (
    <View style={styles.callCard}>
      <View style={styles.callCardIcon}>
        {icon}
      </View>
      <View style={styles.callCardText}>
        <Text style={styles.callCardTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.callCardMeta} numberOfLines={1}>
          {lasted ? `${lasted} — ${when}` : when}
        </Text>
      </View>
      {joinable ? (
        <TouchableOpacity
          style={styles.callCardJoin}
          activeOpacity={0.7}
          onPress={() => onJoin(entry.isVideo ? 'video' : 'voice')}
          accessibilityRole="button"
          accessibilityLabel={t.channel.joinCall}
        >
          <Text style={styles.callCardJoinText}>{t.channel.joinCall}</Text>
        </TouchableOpacity>
      ) : (
        <CallerAvatar name={entry.callerName} avatar={entry.callerAvatar} styles={styles} />
      )}
    </View>
  );
}

function CallerAvatar({ name, avatar, styles }: Readonly<{ name: string; avatar?: string; styles: Styles }>) {
  if (avatar) return <Image source={{ uri: avatar }} style={styles.callCardAvatar} />;
  return (
    <View style={[styles.callCardAvatar, styles.callCardAvatarFallback]}>
      <Text style={styles.callCardAvatarInitial}>{(name || '?')[0].toUpperCase()}</Text>
    </View>
  );
}

function DateSeparator({ label, styles }: Readonly<{ label: string; styles: Styles }>) {
  return (
    <View style={styles.dateSeparator}>
      <View style={styles.dateLine} />
      <Text style={styles.dateLabel}>{label}</Text>
      <View style={styles.dateLine} />
    </View>
  );
}

function replyQuoteText(
  replyRef: ChatReplyReference,
  membersMap: Map<string, string>,
  labels: { attachment: string; originalMessage: string },
): string {
  if (replyRef.content) {
    return mentionsToPlainText(replyRef.content, membersMap).replaceAll(/\s+/g, ' ');
  }
  return replyRef.hasAttachments ? labels.attachment : labels.originalMessage;
}

function ReplyQuote({
  replyRef,
  membersMap,
  styles,
  onJump,
}: Readonly<{
  replyRef: ChatReplyReference;
  membersMap: Map<string, string>;
  styles: Styles;
  onJump: (messageId: string) => void;
}>) {
  const { t } = useI18n();
  return (
    <TouchableOpacity
      style={styles.replyQuote}
      activeOpacity={0.6}
      hitSlop={{ top: 6, bottom: 4 }}
      onPress={() => onJump(replyRef.messageId)}
    >
      <View style={styles.replyQuoteSpine} />
      {replyRef.authorAvatar ? (
        <Image source={{ uri: replyRef.authorAvatar }} style={styles.replyQuoteAvatar} />
      ) : (
        <View style={[styles.replyQuoteAvatar, styles.replyQuoteAvatarFallback]}>
          <Text style={styles.replyQuoteAvatarText}>{(replyRef.authorName || '?')[0].toUpperCase()}</Text>
        </View>
      )}
      <Text style={styles.replyQuoteAuthor} numberOfLines={1}>
        {replyRef.authorName}
      </Text>
      <Text style={styles.replyQuoteText} numberOfLines={1}>
        {replyQuoteText(replyRef, membersMap, t.channel)}
      </Text>
    </TouchableOpacity>
  );
}

function ImageAttachment({
  att,
  styles,
  onOpen,
}: Readonly<{ att: ChatAttachment; styles: Styles; onOpen: OpenImage }>) {
  const handlePress = (e: GestureResponderEvent) => {
    // Grow the photo FROM its thumbnail spot into the centered
    // fullscreen viewer (shared-element). Measure the thumbnail's
    // window rect so the viewer can interpolate from it to center.
    const target = e.currentTarget as unknown as MeasurableTarget;
    if (target?.measureInWindow) {
      target.measureInWindow((x, y, w, h) => onOpen(att.url, { x, y, width: w, height: h }));
    } else {
      onOpen(att.url, null);
    }
  };
  return (
    <TouchableOpacity activeOpacity={1} onPress={handlePress}>
      <Image source={{ uri: att.url }} style={styles.attachmentImage} resizeMode="cover" />
    </TouchableOpacity>
  );
}

function AttachmentItem({
  att,
  colors,
  styles,
  onOpenImage,
}: Readonly<{
  att: ChatAttachment;
  colors: ThemeColors;
  styles: Styles;
  onOpenImage: OpenImage;
}>) {
  if (att.mimeType.startsWith('image/')) {
    return <ImageAttachment att={att} styles={styles} onOpen={onOpenImage} />;
  }
  if (att.mimeType.startsWith('audio/')) {
    return <AudioPlayer uri={att.url} />;
  }
  return (
    <TouchableOpacity style={styles.attachmentFile} onPress={() => openExternalUrl(att.url)}>
      <FileText size={20} color={colors.muted} />
      <View style={styles.attachmentFileInfo}>
        <Text style={styles.attachmentFileName} numberOfLines={1}>{att.fileName}</Text>
        <Text style={styles.attachmentFileSize}>{formatFileSize(att.fileSize)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function MessageAttachments({
  attachments,
  colors,
  styles,
  onOpenImage,
}: Readonly<{
  attachments: ChatAttachment[];
  colors: ThemeColors;
  styles: Styles;
  onOpenImage: OpenImage;
}>) {
  return (
    <View style={styles.attachmentList}>
      {attachments.map((att) => (
        <AttachmentItem
          key={att.id}
          att={att}
          colors={colors}
          styles={styles}
          onOpenImage={onOpenImage}
        />
      ))}
    </View>
  );
}

/** Message text, edited marker, attachments and reactions (shared by both row layouts). */
function MessageExtras({
  item,
  membersMap,
  currentUserId,
  colors,
  styles,
  onOpenImage,
  onToggleReaction,
}: Readonly<{
  item: Message;
  membersMap: Map<string, string>;
  currentUserId: string;
  colors: ThemeColors;
  styles: Styles;
  onOpenImage: OpenImage;
  onToggleReaction: (messageId: string, emoji: string) => void;
}>) {
  const { t } = useI18n();
  const { reactions, attachments } = item;
  return (
    <>
      {item.content ? renderMessageText(item.content, membersMap, colors) : null}
      {item.editedAt ? <Text style={styles.editedLabel}>{t.channel.edited}</Text> : null}
      {attachments && attachments.length > 0 && (
        <MessageAttachments
          attachments={attachments}
          colors={colors}
          styles={styles}
          onOpenImage={onOpenImage}
        />
      )}
      {reactions && Object.keys(reactions).length > 0 ? (
        <ReactionBar
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={(emoji) => onToggleReaction(item.id, emoji)}
        />
      ) : null}
    </>
  );
}

function MessageAvatar({ item, styles }: Readonly<{ item: Message; styles: Styles }>) {
  if (item.authorAvatar) {
    return <Image source={{ uri: item.authorAvatar }} style={styles.msgAvatarImg} />;
  }
  return (
    <View style={styles.msgAvatar}>
      <Text style={styles.msgAvatarText}>
        {(item.authorName || '?')[0].toUpperCase()}
      </Text>
    </View>
  );
}

function ThreadLink({
  count,
  colors,
  styles,
  onPress,
}: Readonly<{ count: number; colors: ThemeColors; styles: Styles; onPress: () => void }>) {
  const { t, plural } = useI18n();
  return (
    <TouchableOpacity style={styles.threadLink} onPress={onPress}>
      <MessageSquare size={14} color={colors.info} />
      <Text style={styles.threadText}>{plural(count, t.channel.replyCount)}</Text>
    </TouchableOpacity>
  );
}

function HeaderAvatar({
  isDm,
  isPrivate,
  picture,
  channelName,
  peerIsOnline,
  colors,
  styles,
}: Readonly<{
  isDm: boolean;
  isPrivate: boolean;
  picture?: string | null;
  channelName: string;
  peerIsOnline: boolean | null;
  colors: ThemeColors;
  styles: Styles;
}>) {
  if (!isDm) {
    const ChannelIcon = isPrivate ? Lock : Hash;
    return (
      <View style={styles.headerChannelIcon}>
        <ChannelIcon size={20} color={colors.text} strokeWidth={2.2} />
      </View>
    );
  }
  return (
    <View style={styles.headerAvatarWrap}>
      {picture ? (
        <Image source={{ uri: picture }} style={styles.headerAvatar} />
      ) : (
        <View style={styles.headerAvatarFallback}>
          <Text style={styles.headerAvatarText}>
            {(channelName || '?')[0].toUpperCase()}
          </Text>
        </View>
      )}
      {peerIsOnline && <View style={styles.headerPresenceDot} />}
    </View>
  );
}

function ChannelHeader({
  hideBackButton,
  isDm,
  isPrivate,
  channelName,
  picture,
  peerIsOnline,
  inCall,
  joinableCall,
  identityEnabled,
  colors,
  styles,
  onBack,
  onOpenIdentity,
  onStartCall,
}: Readonly<{
  hideBackButton?: boolean;
  isDm: boolean;
  isPrivate: boolean;
  channelName: string;
  picture?: string | null;
  peerIsOnline: boolean | null;
  inCall: boolean;
  /** A call is running here that you are not in: the call buttons become "Join". */
  joinableCall: ActiveCall['callType'] | null;
  /** Tapping the name opens the DM peer's profile, or the channel details. */
  identityEnabled: boolean;
  colors: ThemeColors;
  styles: Styles;
  onBack: () => void;
  onOpenIdentity: () => void;
  onStartCall: (callType: 'voice' | 'video') => void;
}>) {
  const { t } = useI18n();
  return (
    <View style={styles.header}>
      <View style={[styles.headerContent, hideBackButton && styles.headerContentNoBack]}>
        {!hideBackButton && (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
          >
            <ChevronLeft size={28} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.headerIdentity}
          activeOpacity={0.6}
          onPress={onOpenIdentity}
          disabled={!identityEnabled}
          accessibilityRole={identityEnabled ? 'button' : undefined}
          accessibilityLabel={
            identityEnabled && !isDm ? `${channelName}, ${t.channel.channelDetails}` : undefined
          }
        >
          <HeaderAvatar
            isDm={isDm}
            isPrivate={isPrivate}
            picture={picture}
            channelName={channelName}
            peerIsOnline={peerIsOnline}
            colors={colors}
            styles={styles}
          />
          <View style={styles.headerIdentityText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {channelName || t.channel.loadingTitle}
            </Text>
            {isDm && peerIsOnline !== null && (
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {peerIsOnline ? t.channel.activeNow : t.channel.offline}
              </Text>
            )}
          </View>
        </TouchableOpacity>

        {joinableCall ? (
          <TouchableOpacity
            style={styles.headerJoin}
            activeOpacity={0.7}
            onPress={() => onStartCall(joinableCall)}
            accessibilityRole="button"
            accessibilityLabel={`${t.channel.joinCall}: ${
              joinableCall === 'video' ? t.inCall.videoCall : t.inCall.voiceCall
            }`}
          >
            {joinableCall === 'video' ? (
              <VideoCameraIcon size={18} color="#fff" fill="#fff" strokeWidth={2} />
            ) : (
              <Phone size={16} color="#fff" fill="#fff" strokeWidth={2} />
            )}
            <Text style={styles.headerJoinText}>{t.channel.joinCall}</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.headerActions}>
            {/* While a call is already active (e.g. minimized to the top bar),
                disable the call buttons so tapping them can't start a second call. */}
            <TouchableOpacity
              style={[styles.headerAction, inCall && styles.headerActionDisabled]}
              activeOpacity={0.5}
              disabled={inCall}
              onPress={() => onStartCall('video')}
              accessibilityRole="button"
              accessibilityLabel={t.channel.startVideoCall}
            >
              <Video size={24} color={colors.text} strokeWidth={1.8} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.headerAction, inCall && styles.headerActionDisabled]}
              activeOpacity={0.5}
              disabled={inCall}
              onPress={() => onStartCall('voice')}
              accessibilityRole="button"
              accessibilityLabel={t.channel.startVoiceCall}
            >
              <Phone size={21} color={colors.text} strokeWidth={1.8} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

/** Pinned message bar. */
function PinnedBar({
  current,
  count,
  position,
  colors,
  styles,
  onPress,
  onUnpin,
}: Readonly<{
  current: Message | undefined;
  count: number;
  position: number;
  colors: ThemeColors;
  styles: Styles;
  onPress: () => void;
  onUnpin: () => void;
}>) {
  const { t, format } = useI18n();
  if (!current) return null;
  return (
    <TouchableOpacity style={styles.pinnedBar} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.pinnedLineContainer}>
        {Array.from({ length: count }, (_, i) => (
          <View
            key={i}
            style={[
              styles.pinnedLineSegment,
              { backgroundColor: i === position ? BRAND : colors.secondary },
            ]}
          />
        ))}
      </View>
      <View style={styles.pinnedContent}>
        <Text style={styles.pinnedAuthor} numberOfLines={1}>
          {current.authorName}
          {count > 1 && (
            <Text style={styles.pinnedCount}>{`  ${format(t.channel.pinPosition, { position: position + 1, count })}`}</Text>
          )}
        </Text>
        <Text style={styles.pinnedText} numberOfLines={1}>
          {current.content}
        </Text>
      </View>
      <TouchableOpacity onPress={onUnpin} hitSlop={HIT_SLOP}>
        <X size={16} color={colors.muted} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

/** Edit mode banner. */
function EditBar({
  active,
  colors,
  styles,
  onClose,
}: Readonly<{ active: boolean; colors: ThemeColors; styles: Styles; onClose: () => void }>) {
  const { t } = useI18n();
  if (!active) return null;
  return (
    <View style={styles.editBar}>
      <Pencil size={14} color={BRAND} strokeWidth={2.5} />
      <Text style={styles.editBarLabel} numberOfLines={1}>
        {t.channel.editingMessage}
      </Text>
      <TouchableOpacity style={styles.editBarClose} onPress={onClose} hitSlop={HIT_SLOP}>
        <X size={14} color={colors.text} strokeWidth={3} />
      </TouchableOpacity>
    </View>
  );
}

/** Long reply chain → suggest continuing in a thread (Discord-style). */
function ThreadSuggestion({
  visible,
  colors,
  styles,
  onContinue,
  onDismiss,
}: Readonly<{
  visible: boolean;
  colors: ThemeColors;
  styles: Styles;
  onContinue: () => void;
  onDismiss: () => void;
}>) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <View style={styles.threadSuggest}>
      <MessageSquare size={16} color={BRAND} strokeWidth={2.2} />
      <Text style={styles.threadSuggestText} numberOfLines={2}>
        {t.channel.threadSuggestion}
      </Text>
      <TouchableOpacity style={styles.threadSuggestBtn} onPress={onContinue} activeOpacity={0.8}>
        <Text style={styles.threadSuggestBtnText}>{t.channel.createThread}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onDismiss}
        hitSlop={HIT_SLOP}
        accessibilityLabel={t.channel.dismissThreadSuggestion}
      >
        <X size={14} color={colors.muted} strokeWidth={2.5} />
      </TouchableOpacity>
    </View>
  );
}

/** Reply preview. */
/**
 * The reply row at the top of the composer card, as in Discord: who you're
 * replying to, and close.
 */
function ReplyHeader({
  replyTo,
  colors,
  styles,
  onClose,
}: Readonly<{
  replyTo: ReplyTarget;
  colors: ThemeColors;
  styles: Styles;
  onClose: () => void;
}>) {
  const { t } = useI18n();
  return (
    <>
      <Text style={styles.replyHeaderLabel} numberOfLines={1}>
        {t.channel.replyingTo} <Text style={styles.replyHeaderName}>{replyTo.authorName}</Text>
      </Text>
      <TouchableOpacity
        style={styles.replyHeaderClose}
        onPress={onClose}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t.channel.cancelReply}
      >
        <X size={18} color={colors.mutedForeground} strokeWidth={2.4} />
      </TouchableOpacity>
    </>
  );
}

function typingLabel(
  typingUsers: string[],
  membersMap: Map<string, string>,
  t: Translations,
  format: (template: string, values?: Record<string, unknown>) => string,
): string {
  const name = membersMap.get(typingUsers[0]) ?? t.channel.someone;
  if (typingUsers.length === 1) return format(t.channel.typingOne, { name });
  if (typingUsers.length === 2) {
    const other = membersMap.get(typingUsers[1]) ?? t.channel.someone.toLowerCase();
    return format(t.channel.typingTwo, { name, other });
  }
  return format(t.channel.typingMany, { name, count: typingUsers.length - 1 });
}

function TypingIndicator({
  typingUsers,
  membersMap,
  styles,
}: Readonly<{ typingUsers: string[]; membersMap: Map<string, string>; styles: Styles }>) {
  const { t, format } = useI18n();
  if (typingUsers.length === 0) return null;
  return (
    <View style={styles.typingRow}>
      <Text style={styles.typingText}>{typingLabel(typingUsers, membersMap, t, format)}</Text>
    </View>
  );
}

interface ComposerProps extends Omit<ExpandedComposerProps, 'onFocus' | 'onBlur' | 'placeholder'> {
  colors: ThemeColors;
  styles: Styles;
  isDm: boolean;
  channelName: string;
  isArchived: boolean;
  /** Recording, or uploading the recording just taken. */
  isRecording: boolean;
  isSendingVoice: boolean;
  isInputExpanded: boolean;
  meteringDb: number;
  recordingMs: number;
  /** Animated side/bottom insets: pill while idle, card while typing. */
  barStyle: ReturnType<typeof useComposerBarStyle>;
  bottomInset: number;
  /** The idle pill's mic. */
  onStartRecording: () => void;
  onFocusInput: () => void;
  onBlurInput: () => void;
  onUnarchive: () => void;
  onCancelRecording: () => void;
  onSendRecording: () => void;
}

/** Archived banner plus the input bar (recording / expanded / collapsed). */
function Composer(props: Readonly<ComposerProps>) {
  const { isArchived, isRecording, isInputExpanded, colors, styles } = props;
  const { t, format } = useI18n();
  // Until the channel name is known (route param or loaded channel) the
  // placeholder stays neutral instead of reading "Message #".
  const placeholder =
    props.isDm || !props.channelName
      ? t.composer.messageDm
      : format(t.composer.messageChannel, { name: props.channelName });

  let inputBody: React.ReactNode;
  if (isRecording) {
    inputBody = (
      <RecordingPill
        meteringDb={props.meteringDb}
        durationMs={props.recordingMs}
        sending={props.isSendingVoice}
        onCancel={props.onCancelRecording}
        onSend={props.onSendRecording}
      />
    );
  } else if (isInputExpanded) {
    inputBody = (
      <ExpandedComposer
        {...props}
        placeholder={placeholder}
        onFocus={props.onFocusInput}
        onBlur={props.onBlurInput}
      />
    );
  } else {
    inputBody = (
      <CollapsedComposer
        placeholder={placeholder}
        onAttach={props.onAttach}
        onExpand={props.onFocusInput}
        onStartRecording={props.onStartRecording}
      />
    );
  }

  return (
    <>
      {isArchived ? (
        <View style={styles.archivedBanner}>
          <Archive size={16} color={colors.muted} />
          <Text style={styles.archivedText}>{t.channel.archivedNotice}</Text>
          <TouchableOpacity style={styles.unarchiveBtn} onPress={props.onUnarchive}>
            <Text style={styles.unarchiveBtnText}>{t.channel.unarchive}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {/* Input bar */}
      <ComposerBarFrame
        idle={!isRecording && !isInputExpanded}
        animatedStyle={props.barStyle}
        bottomInset={props.bottomInset}
        style={[styles.inputBar, isArchived && styles.inputBarHidden]}
      >
        {inputBody}
      </ComposerBarFrame>
    </>
  );
}

const PIN_DURATIONS = [
  { label: 'pin24h', value: '24h' },
  { label: 'pin7d', value: '7d' },
  { label: 'pin30d', value: '30d' },
  { label: 'pinAlways', value: 'forever' },
] as const;

const PIN_DURATION_MS: Record<string, number | undefined> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Pin duration picker, then the "notify others?" step. */
function PinDurationModal({
  visible,
  pinDuration,
  colors,
  styles,
  onRequestClose,
  onDismiss,
  onSelectDuration,
  onConfirm,
}: Readonly<{
  visible: boolean;
  pinDuration: string | null;
  colors: ThemeColors;
  styles: Styles;
  onRequestClose: () => void;
  onDismiss: () => void;
  onSelectDuration: (duration: string) => void;
  onConfirm: (silent: boolean) => void;
}>) {
  const { t } = useI18n();
  const optionStyle = ({ pressed }: { pressed: boolean }) => [
    styles.pinDurationOption,
    pressed && styles.pinDurationOptionPressed,
  ];

  const durationStep = (
    <>
      <Text style={styles.pinDurationTitle}>{t.channel.pinForHowLong}</Text>
      {PIN_DURATIONS.map((opt) => (
        <Pressable
          key={opt.value}
          style={optionStyle}
          onPress={() => onSelectDuration(opt.value)}
        >
          {opt.value === 'forever' ? (
            <InfinityIcon size={20} color={colors.text} />
          ) : (
            <Clock size={20} color={colors.text} />
          )}
          <Text style={styles.pinDurationOptionText}>{t.channel[opt.label]}</Text>
        </Pressable>
      ))}
    </>
  );

  const notifyStep = (
    <>
      <Text style={styles.pinDurationTitle}>{t.channel.notifyOthers}</Text>
      <Pressable style={optionStyle} onPress={() => onConfirm(false)}>
        <Bell size={20} color={colors.text} />
        <View style={styles.pinOptionContent}>
          <Text style={styles.pinDurationOptionText}>{t.channel.pinWithAlert}</Text>
          <Text style={styles.pinOptionDesc}>{t.channel.pinWithAlertHint}</Text>
        </View>
      </Pressable>
      <Pressable style={optionStyle} onPress={() => onConfirm(true)}>
        <BellOff size={20} color={colors.muted} />
        <View style={styles.pinOptionContent}>
          <Text style={styles.pinDurationOptionText}>{t.channel.pinSilently}</Text>
          <Text style={styles.pinOptionDesc}>{t.channel.pinSilentlyHint}</Text>
        </View>
      </Pressable>
    </>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <Pressable style={styles.pinDurationBackdrop} onPress={onDismiss}>
        <Pressable style={styles.pinDurationSheet}>
          <View style={styles.pinDurationHandle}>
            <View style={styles.pinDurationHandleBar} />
          </View>
          {pinDuration ? notifyStep : durationStep}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Shown as the inverted list's ListEmptyComponent.
 *
 * VirtualizedList hands every empty component a `style` (and `onLayout`) via
 * cloneElement: the counter-transform that undoes the list's own inversion
 * (scaleY on iOS, scale on Android). A component that drops them renders
 * flipped, so both are forwarded to the root view here.
 */
function EmptyChannel({
  isDm,
  channelName,
  loading,
  colors,
  styles,
  style,
  onLayout,
}: Readonly<{
  isDm: boolean;
  channelName: string;
  /** Messages or channel still loading: no welcome text yet. */
  loading: boolean;
  colors: ThemeColors;
  styles: Styles;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
}>) {
  const { t, format } = useI18n();
  if (loading) {
    return (
      <View style={[styles.empty, style]} onLayout={onLayout}>
        <ActivityIndicator size="small" color={colors.muted} />
      </View>
    );
  }
  return (
    <View style={[styles.empty, style]} onLayout={onLayout}>
      <Text style={styles.emptyTitle}>
        {format(isDm ? t.channel.dmConversation : t.channel.welcome, { name: channelName })}
      </Text>
      <Text style={styles.emptyText}>{t.channel.startOfConversation}</Text>
    </View>
  );
}

interface ChannelViewProps {
  channelId: string;
  hideBackButton?: boolean;
  hideHeader?: boolean;
  /** Name from the list the user tapped, shown until the channel itself loads. */
  initialName?: string;
  /** Channel type from the same list item ('dm', 'public', 'private'). */
  initialType?: string;
}

export function ChannelView({
  channelId,
  hideBackButton,
  hideHeader,
  initialName,
  initialType,
}: Readonly<ChannelViewProps>) {
  const { markInteractive } = useObserve();
  const { t, format, intlLocale } = useI18n();
  const { userId } = useAuth();
  const { user } = useUser();
  const { organization } = useOrganization();
  const workspaceId = organization?.id ?? null;
  const toast = useToast();
  const { startCall, joinCall, activeChannelCalls, setChannelActiveCall, session } = useCall();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.top, insets.bottom),
    [colors, insets.top, insets.bottom],
  );

  // Seed/track an already-active call in this channel so we can show a
  // "Join call" banner. Kept live afterwards by call_started / call_ended.
  useEffect(() => {
    let cancelled = false;
    appApi.chatCalls
      .activeForChannel(channelId)
      .then((res) => {
        if (cancelled) return;
        setChannelActiveCall(
          channelId,
          res.data ? { callId: res.data.id, callType: res.data.callType } : null,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [channelId, setChannelActiveCall]);

  const activeCall = activeChannelCalls[channelId] ?? null;

  // Measured composer heights for the two states (just the endpoints — these
  // are stable measurements, not timing-critical).
  const collapsedStackHeightSV = useSharedValue(50);
  const expandedStackHeightSV = useSharedValue(92);
  // 1 while the composer is expanded (focused / has text / reply / attachment),
  // 0 while collapsed — independent of the keyboard. Lets the list reservation
  // track the composer's ACTUAL height even when the keyboard is gone (e.g.
  // swipe-to-dismiss with text still in the field), so the last message never
  // hides behind a still-tall composer.
  const inputExpandedSV = useSharedValue(0);

  // Reanimated keyboard animation:
  //   kbAnimHeight: 0 (closed) → -keyboardHeight (open)
  //   progress:     0 (closed) → 1 (open)
  const { progress, height: kbAnimHeight } = useReanimatedKeyboardAnimation();
  const listContainerStyle = useAnimatedStyle(() => ({
    marginBottom: -kbAnimHeight.value - insets.bottom * progress.value,
  }));
  // The chat's bottom reservation (an animated spacer at the visual bottom of
  // the inverted list) is driven DIRECTLY by the keyboard's own `progress`
  // SharedValue — interpolating collapsed↔expanded composer height. Because it
  // IS the keyboard's animation value, the reservation moves frame-perfectly
  // with the keyboard slide on both open and dismiss: zero startup lag (no JS
  // roundtrip), zero bounce. A static paddingTop snapped in one frame; a
  // withTiming started late and bounced — driving off `progress` does neither.
  const listHeaderSpacerStyle = useAnimatedStyle(() => {
    // Keyboard-driven reservation — frame-perfect with the keyboard slide.
    const keyboardDriven = interpolate(
      progress.value,
      [0, 1],
      [collapsedStackHeightSV.value, expandedStackHeightSV.value],
      Extrapolation.CLAMP,
    );
    // Floor at the composer's real current height. When the keyboard is
    // dismissed but the composer stays expanded (text still in the field),
    // `progress` is 0 yet the composer is tall — without this floor the
    // reservation would shrink to the collapsed height and the last message
    // would slip behind the composer.
    const composerDriven =
      inputExpandedSV.value === 1 ? expandedStackHeightSV.value : collapsedStackHeightSV.value;
    return { height: Math.max(keyboardDriven, composerDriven) + 30 };
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [input, setInput] = useState('');
  const [channel, setChannel] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  // Older history, a page at a time as the list is scrolled up.
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  // Once an older page is in, a refresh of the newest page keeps it and no
  // longer moves the cursor back to the start.
  const olderLoadedRef = useRef(false);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  // The messages' height: while they don't fill the screen there is nothing to
  // scroll, so the next page is fetched straight away. (The list's own height
  // moves with the keyboard on the UI thread, without layout events, so the
  // screen's height is the measure.)
  const { height: windowHeight } = useWindowDimensions();
  const contentHeightRef = useRef(0);
  // The message "More reactions" was opened for. Kept apart from
  // selectedMessage, which the actions sheet clears as it closes.
  const [reactionTarget, setReactionTarget] = useState<Message | null>(null);
  // Whatever was being typed when an edit started, put back afterwards.
  const draftBeforeEditRef = useRef('');
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [viewingImageOrigin, setViewingImageOrigin] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [showPinDuration, setShowPinDuration] = useState(false);
  const [pinDuration, setPinDuration] = useState<string | null>(null);
  const [messageToPin, setMessageToPin] = useState<Message | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; uri: string; mimeType: string }[]>([]);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [replyMention, setReplyMention] = useState(true);
  // Reply chains (by root message id) whose "continue in a thread?" prompt the
  // user dismissed — don't nag again for the same conversation.
  const [dismissedThreadSuggestions, setDismissedThreadSuggestions] = useState<Set<string>>(new Set());
  // Optimistic sends still waiting to show up in a server fetch, keyed by their
  // temporary id. `serverId` is filled in once the POST answers, so the next
  // fetch that contains it can retire the placeholder without a flicker.
  const pendingSendsRef = useRef(new Map<string, { message: Message; serverId?: string }>());
  const [membersMap, setMembersMap] = useState<Map<string, string>>(new Map());
  // userId → workspace membership status ('ACTIVE' ⇒ online). The roster has no
  // real last-seen feed, so this is the same coarse presence proxy the profile
  // screen uses (app/user/[userId].tsx).
  const [memberStatus, setMemberStatus] = useState<Map<string, string>>(new Map());
  const [localPinnedIds, setLocalPinnedIds] = useState<Set<string>>(new Set());
  const [isInputFocused, setIsInputFocused] = useState(false);
  // Edit mode: when set, the composer acts as an inline editor
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  // Draft autosave: track the current draft id for this channel
  const draftIdRef = useRef<string | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while clearDraft is deleting the draft. saveDraft checks this so an
  // autosave that fires (or a create that resolves) mid-delete doesn't leave an
  // orphan draft behind.
  const isDeletingDraftRef = useRef(false);
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const inputScrollRef = useRef<ScrollView>(null);
  const inputContentHeightRef = useRef(0);
  const inputUserScrollingRef = useRef(false);
  // Show a "jump to newest" button once the user scrolls up away from the
  // bottom of the (inverted) list.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const scrollToBottom = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const { isRecording, durationMs, meteringDb, startRecording, stopRecording, cancelRecording } =
    useVoiceRecorder();
  // A recorded voice message is uploading: the recording bar stays up, frozen
  // at the final length, with a spinner in the send button.
  const [sendingVoiceMs, setSendingVoiceMs] = useState<number | null>(null);
  const showRecordingBar = isRecording || sendingVoiceMs !== null;

  const isInputExpanded =
    isInputFocused || input.length > 0 || pendingFiles.length > 0 || replyTo !== null;

  // Mirror the expanded state into a shared value so the list reservation can
  // floor itself at the real composer height (see listHeaderSpacerStyle).
  // Plain assignment (no timing) keeps the keyboard-open transition bounce-free.
  useEffect(() => {
    inputExpandedSV.value = isInputExpanded ? 1 : 0;
  }, [isInputExpanded, inputExpandedSV]);

  // The composer widens from the idle pill (38pt insets) to the card (12pt)
  // in step with the keyboard, as ChatGPT's does, instead of jumping on tap.
  // With the keyboard down but text still in the field it stays a card; the
  // recording bar is always the pill.
  const composerHeldOpenSV = useSharedValue(0);
  useEffect(() => {
    composerHeldOpenSV.value = isInputExpanded && !isInputFocused && !showRecordingBar ? 1 : 0;
  }, [isInputExpanded, isInputFocused, showRecordingBar, composerHeldOpenSV]);
  const composerBarStyle = useComposerBarStyle(progress, composerHeldOpenSV, insets.bottom);
  // Collapse as the keyboard goes down, not a beat after it (see useKeyboardHide).
  const handleKeyboardHide = useCallback(() => setIsInputFocused(false), []);
  useKeyboardHide(handleKeyboardHide);

  // The expanded TextInput uses `autoFocus`, so it grabs focus the instant it
  // mounts — no setTimeout tick, no perceptible delay when the user taps the
  // collapsed placeholder to expand the composer.


  // Load workspace members for mention resolution
  useEffect(() => {
    void (async () => {
      try {
        const res = await appApi.chatMembers.list();
        const map = new Map<string, string>();
        const statusMap = new Map<string, string>();
        for (const m of res.data ?? []) {
          if (m.userId && m.name) map.set(m.userId, m.name);
          if (m.userId && m.status) statusMap.set(m.userId, m.status);
        }
        setMembersMap(map);
        setMemberStatus(statusMap);
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  // Subscribe to realtime updates
  const { typingUsers, onKeystroke, onSend } = useChatRealtime(channelId, loadMessages);

  const handleAttach = useCallback(() => {
    openAttachmentPicker((files) => setPendingFiles((prev) => [...prev, ...files]));
  }, []);

  const handleStartRecording = useCallback(async () => {
    Keyboard.dismiss();
    const result = await startRecording();
    if (result === 'started') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else if (result === 'denied') {
      Alert.alert(t.composer.micPermissionTitle, t.composer.micPermissionBody, [
        { text: t.common.cancel, style: 'cancel' },
        { text: t.composer.openSettings, onPress: () => void Linking.openSettings() },
      ]);
    } else {
      toast.error(t.composer.recordFailed);
    }
  }, [startRecording, t, toast]);

  // Throws the recording away; nothing is uploaded.
  const handleCancelRecording = useCallback(async () => {
    await cancelRecording();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [cancelRecording]);

  const handleSendRecording = useCallback(async () => {
    // A tap-and-send by accident gives a near-silent clip: drop it instead.
    if (durationMs < MIN_VOICE_MESSAGE_MS) {
      await cancelRecording();
      toast.error(t.composer.voiceTooShort);
      return;
    }
    setSendingVoiceMs(durationMs);
    const result = await stopRecording();
    try {
      if (!result) throw new Error('No recording to send');
      const uploaded = await uploadChatAttachment(channelId, result);
      if (!uploaded) throw new Error('Voice message upload failed');
      await appApi.chatMessages.create({ channelId, body: '', attachments: [uploaded] });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void loadMessages();
      onSend();
    } catch (err) {
      console.error('[WeldChat] Voice message send failed:', err);
      toast.error(t.composer.voiceSendFailed);
    } finally {
      setSendingVoiceMs(null);
    }
  }, [durationMs, cancelRecording, stopRecording, channelId, onSend, t, toast]);

  useEffect(() => {
    setMessages([]);
    setChannel(null);
    setInput('');
    setEditingMessage(null);
    setReplyTo(null);
    setMentionQuery(null);
    pendingSendsRef.current.clear();
    draftIdRef.current = null;
    olderLoadedRef.current = false;
    setOlderCursor(null);
    setHasOlder(false);
    setMessagesLoading(true);
    void loadChannel();
    void loadMessages();
    // Load draft for this channel if composer is empty. The server scopes
    // drafts to the authenticated caller (JWT) — no client-supplied userId.
    if (userId) {
      appApiClient.get<{ data: { id: string; content: string }[] }>(
        `/chat-drafts?channelId=${encodeURIComponent(channelId)}`
      ).then((draftRes) => {
        const drafts = draftRes.data ?? [];
        if (drafts.length > 0 && drafts[0].content) {
          draftIdRef.current = drafts[0].id;
          setInput(drafts[0].content);
        }
      }).catch(() => {});
    }
  }, [channelId]);

  useEffect(() => {
    if (!messagesLoading) {
      hideAppSplash();
      markInteractive();
    }
  }, [messagesLoading, markInteractive]);

  const loadChannel = async () => {
    try {
      const res = await appApi.channels.get(channelId);
      let channelData: any = res.data;
      if (channelData?.type === 'dm') {
        const dmRes = await appApi.chatDm.list();
        const dms = dmRes.data ?? [];
        const dm: any = Array.isArray(dms) ? dms.find((d: any) => d.id === channelId) : null;
        if (dm) {
          // Derive the DM header from otherMembers (the backend doesn't return a
          // display name / picture / otherUserId for DMs) — matches the DM list
          // screen and the platform sidebar.
          const others = (dm.otherMembers ?? []).filter((m: any) => m?.userId);
          const isGroup = others.length > 1;
          const first = others[0];
          const displayName = isGroup
            ? others.map((m: any) => m.name || m.email || 'Unknown').join(', ') || dm.name || 'Group'
            : first?.name || first?.email || dm.name || 'Direct Message';
          channelData = {
            ...channelData,
            name: displayName,
            picture: isGroup ? null : first?.picture ?? null,
            otherUserId: first?.userId ?? null,
          };
        }
      }
      setChannel(channelData);
    } catch (err) {
      console.error(err);
    }
  };

  async function loadMessages() {
    try {
      const res = await appApi.chatMessages.list({ channelId });
      const raw = res.data ?? [];
      const msgs: Message[] = Array.isArray(raw) ? (raw as unknown as Message[]) : [];
      const merged = msgs.map((m) => ({
        ...m,
        isPinned: m.isPinned || localPinnedIds.has(m.id),
      }));
      // Keep optimistic sends on screen until the server copy is in the list.
      const fetchedIds = new Set(msgs.map((m) => m.id));
      for (const [tempId, entry] of pendingSendsRef.current) {
        if (entry.serverId && fetchedIds.has(entry.serverId)) pendingSendsRef.current.delete(tempId);
      }
      const pending = [...pendingSendsRef.current.values()].map((entry) => entry.message);
      const oldestFetched = msgs.reduce(
        (oldest, m) => Math.min(oldest, new Date(m.createdAt).getTime()),
        Number.POSITIVE_INFINITY,
      );
      setMessages((prev) => {
        const localSystemMsgs = prev.filter((m) => m.type === 'system' && m.id.startsWith('pin-'));
        // Older pages already loaded stay; this refresh only covers the newest.
        const older = prev.filter(
          (m) => !m.pending && !m.id.startsWith('pin-') && !fetchedIds.has(m.id)
            && new Date(m.createdAt).getTime() < oldestFetched,
        );
        return [...older, ...merged, ...localSystemMsgs, ...pending];
      });
      if (!olderLoadedRef.current) {
        setOlderCursor(res.pagination?.cursor ?? null);
        setHasOlder(!!res.pagination?.hasMore);
      }
      // We're viewing this channel, so mark it read — advances our lastReadAt
      // past the latest message (incl. one we just sent). Without this the
      // channel keeps rendering as "unread" (tinted row + accent timestamp) in
      // the DM list. Fire-and-forget; the list refetches on the resulting event.
      appApi.channels.markRead(channelId).catch(() => {});
    } catch (err) {
      console.error(err);
    } finally {
      setMessagesLoading(false);
    }
  }

  // The next page of history, when the list nears its oldest message.
  const loadOlder = useCallback(async () => {
    if (!hasOlder || !olderCursor || loadingOlderRef.current) return;
    const forChannel = channelId;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await appApi.chatMessages.list({ channelId: forChannel, cursor: olderCursor });
      if (channelIdRef.current !== forChannel) return;
      const raw = res.data ?? [];
      const page: Message[] = Array.isArray(raw) ? (raw as unknown as Message[]) : [];
      olderLoadedRef.current = true;
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const fresh = page
          .filter((m) => !known.has(m.id))
          .map((m) => ({ ...m, isPinned: m.isPinned || localPinnedIds.has(m.id) }));
        return [...fresh, ...prev];
      });
      setOlderCursor(res.pagination?.cursor ?? null);
      setHasOlder(!!res.pagination?.hasMore);
    } catch (err) {
      console.error('[WeldChat] Loading older messages failed:', err);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [channelId, hasOlder, olderCursor, localPinnedIds]);

  const fillScreenWithHistory = useCallback(() => {
    const content = contentHeightRef.current;
    if (content > 0 && content < windowHeight) void loadOlder();
  }, [loadOlder, windowHeight]);

  // A page arrived (or the cursor moved on): keep going while the screen isn't full.
  useEffect(() => {
    if (hasOlder) fillScreenWithHistory();
  }, [hasOlder, olderCursor, fillScreenWithHistory]);

  // Draft autosave helpers
  const saveDraft = useCallback((text: string) => {
    if (!userId || !workspaceId) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(async () => {
      // A delete is in flight (composer was cleared / message sent) — don't
      // resurrect the draft.
      if (isDeletingDraftRef.current) return;
      try {
        if (draftIdRef.current) {
          await appApiClient.patch(`/chat-drafts/${draftIdRef.current}`, { content: text });
        } else {
          const res = await appApiClient.post<{ data: { id: string } }>('/chat-drafts', {
            workspaceId,
            channelId,
            content: text,
          });
          const newId = res.data?.id ?? null;
          // If clearDraft ran while this create was in flight, the new record is
          // an orphan — delete it instead of adopting it.
          if (isDeletingDraftRef.current) {
            if (newId) appApiClient.delete(`/chat-drafts/${newId}`).catch(() => {});
          } else {
            draftIdRef.current = newId;
          }
        }
      } catch {
        // Best effort — swallow errors
      }
    }, 800);
  }, [userId, workspaceId, channelId]);

  const clearDraft = useCallback(async () => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    // Flag the delete BEFORE awaiting so an in-flight create (started by a
    // saveDraft already past its clearTimeout) knows to orphan-delete itself.
    isDeletingDraftRef.current = true;
    const id = draftIdRef.current;
    draftIdRef.current = null;
    try {
      if (id) await appApiClient.delete(`/chat-drafts/${id}`);
    } catch {
      // Best effort
    } finally {
      isDeletingDraftRef.current = false;
    }
  }, []);

  // Handle edit-mode submit
  const handleEditSubmit = useCallback(async () => {
    if (!editingMessage || !input.trim()) return;
    const trimmed = input.trim();
    const msgId = editingMessage.id;
    // Optimistic update
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, content: trimmed, editedAt: new Date().toISOString() } : m));
    setInput(draftBeforeEditRef.current);
    draftBeforeEditRef.current = '';
    setEditingMessage(null);
    try {
      await appApi.chatMessages.update(msgId, { content: trimmed });
      void loadMessages();
    } catch (err) {
      console.error('[WeldChat] Edit failed:', err);
      toast.error(t.channel.editFailed);
      // Revert on failure
      void loadMessages();
    }
  }, [editingMessage, input, toast, t]);

  const handleSend = useCallback(async () => {
    // If in edit mode, submit the edit instead
    if (editingMessage) {
      await handleEditSubmit();
      return;
    }

    const trimmed = input.trim();
    if ((!trimmed && pendingFiles.length === 0) || uploading) return;

    // Handle /ask slash command — the AI chat agent has been removed along
    // with the AI backend, so surface an unavailable notice instead of
    // calling the (removed) endpoint.
    if (trimmed.startsWith('/ask ') && trimmed.substring(5).trim()) {
      toast.info(t.channel.aiUnavailable);
      return;
    }

    const files = pendingFiles;
    const reply = replyTo;
    const pingReplyAuthor = replyMention;

    // Clear the composer immediately and show the message optimistically —
    // the request finishes in the background (restored below if it fails).
    setInput('');
    setMentionQuery(null);
    setReplyTo(null);
    setPendingFiles([]);
    void clearDraft();
    onSend();

    const tempId = `pending-${randomUUID()}`;
    const ownLast = messages.find((m) => m.authorId === userId && !m.pending);
    const optimistic: Message = {
      id: tempId,
      authorId: userId ?? '',
      authorName: optimisticAuthorName(userId, membersMap, [user?.fullName, ownLast?.authorName], t.channel.you),
      authorAvatar: user?.imageUrl ?? ownLast?.authorAvatar,
      content: trimmed,
      createdAt: new Date().toISOString(),
      hasAttachments: files.length > 0,
      pending: true,
      metadata: optimisticReplyMetadata(reply),
    };
    pendingSendsRef.current.set(tempId, { message: optimistic });
    setMessages((prev) => [...prev, optimistic]);
    // Scroll to bottom (index 0 on inverted list) after the state update settles
    setTimeout(() => flatListRef.current?.scrollToOffset({ offset: 0, animated: true }), 50);

    try {
      let attachments: ChatAttachment[] | undefined;
      if (files.length > 0) {
        setUploading(true);
        try {
          const results = await Promise.all(files.map((f) => uploadChatAttachment(channelId, f)));
          attachments = results.filter((r): r is NonNullable<typeof r> => r !== null);
        } finally {
          setUploading(false);
        }
        if (attachments.length === 0) throw new Error('Attachment upload failed');
      }

      // HTTP-first: POST to API, server persists + publishes via @weldsuite/realtime.
      // A reply stays in the channel (Discord-style) instead of becoming a
      // thread reply; the server pings the replied-to author when asked.
      const res = await appApi.chatMessages.create({
        channelId,
        body: trimmed,
        attachments,
        replyToId: reply?.messageId,
        replyMention: reply ? pingReplyAuthor : undefined,
      });
      const entry = pendingSendsRef.current.get(tempId);
      if (entry) entry.serverId = res.data?.id;
      void loadMessages();
    } catch (err) {
      console.error('[WeldChat] Send failed:', err);
      pendingSendsRef.current.delete(tempId);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      // Hand the message back so nothing typed is lost.
      setInput((current) => current || trimmed);
      if (reply) setReplyTo((current) => current ?? reply);
      if (files.length > 0) setPendingFiles((current) => (current.length > 0 ? current : files));
      toast.error(t.channel.sendFailed);
    }
  }, [editingMessage, handleEditSubmit, input, channelId, uploading, onSend, userId, user, membersMap, messages, replyTo, replyMention, pendingFiles, clearDraft, toast, t]);

  // Reacting shows at once with a light tap, as in WhatsApp; the server's
  // version replaces it once the request is done (or puts it back if it failed).
  const toggleReaction = useCallback(async (message: Message, emoji: string) => {
    if (!userId) return;
    const hasReacted = message.reactions?.[emoji]?.includes(userId) ?? false;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMessages((prev) =>
      prev.map((m) => (m.id === message.id ? { ...m, reactions: withReaction(m.reactions, emoji, userId, !hasReacted) } : m)),
    );
    try {
      if (hasReacted) {
        await appApi.chatMessages.removeReaction(message.id, emoji);
      } else {
        await appApi.chatMessages.addReaction(message.id, { emoji });
      }
    } catch (err) {
      console.error('[WeldChat] Reaction failed:', err);
      toast.error(t.channel.reactionFailed);
    }
    void loadMessages();
  }, [userId, toast, t]);

  const handleReaction = useCallback((emoji: string) => {
    if (selectedMessage) void toggleReaction(selectedMessage, emoji);
  }, [selectedMessage, toggleReaction]);

  const handleEmojiSelect = useCallback((emoji: string) => {
    if (reactionTarget) void toggleReaction(reactionTarget, emoji);
    setReactionTarget(null);
  }, [reactionTarget, toggleReaction]);

  const handleToggleReaction = useCallback((messageId: string, emoji: string) => {
    const message = messages.find((m) => m.id === messageId);
    if (message) void toggleReaction(message, emoji);
  }, [messages, toggleReaction]);

  // Order for the inverted FlatList: newest first (index 0 renders at the visual
  // bottom). Sort explicitly by createdAt rather than trusting the API/array
  // order — otherwise a newly sent message can land at the top of the chat.
  const newestFirst = useMemo(
    () =>
      [...messages].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [messages],
  );
  const callLog = useMemo(() => buildCallLog([...newestFirst].reverse()), [newestFirst]);
  // What the list shows: a call's end message folds into its start's card.
  const reversedMessages = useMemo(
    () => newestFirst.filter((m) => !callLog.folded.has(m.id)),
    [newestFirst, callLog],
  );

  // All image attachments across the conversation, in chronological order — used
  // by the full-screen viewer's swipe pager + bottom filmstrip (WhatsApp-style).
  const conversationImages = useMemo(() => {
    const imgs: { url: string; authorName: string; createdAt: string }[] = [];
    for (const m of messages) {
      for (const a of m.attachments ?? []) {
        if (a.mimeType?.startsWith('image/')) {
          imgs.push({ url: a.url, authorName: m.authorName, createdAt: m.createdAt });
        }
      }
    }
    return imgs;
  }, [messages]);

  const pinnedMessages = useMemo(() => messages.filter((m) => m.isPinned), [messages]);

  const handlePin = useCallback(() => {
    const msg = selectedMessage;
    if (!msg) return;
    if (msg.isPinned) {
      setLocalPinnedIds((prev) => { const next = new Set(prev); next.delete(msg.id); return next; });
      setMessages((prev) => prev.map((m) => m.id === msg.id ? { ...m, isPinned: false } : m));
      appApi.chatMessages.unpin(msg.id).then(() => loadMessages()).catch(console.error);
    } else {
      if (pinnedMessages.length >= 3) {
        toast.info(t.channel.pinLimit);
        return;
      }
      setMessageToPin(msg);
      setShowPinDuration(true);
    }
  }, [selectedMessage, channelId, pinnedMessages.length, toast, t]);

  const handleSelectDuration = useCallback((duration: string) => {
    setPinDuration(duration);
  }, []);

  const handlePinConfirm = useCallback(async (silent: boolean) => {
    const msg = messageToPin;
    const duration = pinDuration;
    setShowPinDuration(false);
    setPinDuration(null);
    setMessageToPin(null);
    if (!msg || !duration) return;
    try {
      setLocalPinnedIds((prev) => new Set(prev).add(msg.id));
      setMessages((prev) => {
        const updated = prev.map((m) => m.id === msg.id ? { ...m, isPinned: true } : m);
        if (!silent) {
          updated.push({
            id: `pin-${msg.id}-${Date.now()}`,
            authorId: '',
            authorName: '',
            content: format(t.channel.pinnedAMessage, { name: msg.authorName }),
            createdAt: new Date().toISOString(),
            type: 'system',
          });
        }
        return updated;
      });
      let expiresAt: string | undefined;
      if (duration && duration !== 'forever') {
        const ms = PIN_DURATION_MS[duration] ?? 0;
        if (ms > 0) expiresAt = new Date(Date.now() + ms).toISOString();
      }
      await appApi.chatMessages.pin(msg.id, { expiresAt, silent });
      void loadMessages();
    } catch (err) {
      console.error(err);
      toast.error(t.channel.pinFailed);
      setLocalPinnedIds((prev) => { const next = new Set(prev); next.delete(msg.id); return next; });
      void loadMessages();
    }
  }, [messageToPin, channelId, pinDuration, toast, t, format]);

  const handleSaveMessage = useCallback(async () => {
    const msg = selectedMessage;
    if (!msg || !userId) return;
    try {
      await appApiClient.post('/chat-bookmarks', {
        messageId: msg.id,
        channelId,
        userId,
      });
      toast.success(t.channel.savedForLater);
    } catch {
      // Duplicate (already saved) — treat as success
      toast.success(t.channel.alreadySaved);
    }
  }, [selectedMessage, channelId, userId, toast, t]);

  const handleDeleteMessage = useCallback(() => {
    const msg = selectedMessage;
    if (!msg) return;
    Alert.alert(
      t.channel.deleteMessageTitle,
      t.channel.deleteMessageBody,
      [
        { text: t.common.cancel, style: 'cancel' },
        {
          text: t.common.delete,
          style: 'destructive',
          onPress: async () => {
            // Optimistic remove
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
            try {
              await appApi.chatMessages.delete(msg.id);
              void loadMessages();
            } catch (err) {
              console.error('[WeldChat] Delete failed:', err);
              toast.error(t.channel.deleteFailed);
              void loadMessages();
            }
          },
        },
      ],
    );
  }, [selectedMessage, t, toast]);

  const openThread = useCallback((message: Message) => {
    router.push({ pathname: '/thread/[messageId]', params: { messageId: message.id, channelId } } as any);
  }, [channelId]);

  // Bring the keyboard back to the composer. The message menu dismisses it, which
  // collapses an empty composer; expanding it again mounts a TextInput that
  // autofocuses, and an already expanded one is focused directly.
  const focusComposer = useCallback(() => {
    setIsInputFocused(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const startReply = useCallback((message: Message) => {
    setReplyTo(replyTargetFor(message));
    setReplyMention(true);
    focusComposer();
  }, [focusComposer]);

  // Discord-style "this is becoming a conversation" nudge: shown while replying
  // deep into a reply chain, offers to continue in a thread on the chain's root.
  const showThreadSuggestion =
    !!replyTo &&
    !editingMessage &&
    channel?.threadsEnabled !== false &&
    replyTo.depth >= THREAD_SUGGESTION_DEPTH &&
    !dismissedThreadSuggestions.has(replyTo.rootId);

  const continueInThread = useCallback(() => {
    if (!replyTo) return;
    const draft = input;
    setReplyTo(null);
    setInput('');
    setMentionQuery(null);
    void clearDraft();
    router.push({
      pathname: '/thread/[messageId]',
      params: { messageId: replyTo.rootId, channelId, draft },
    } as any);
  }, [replyTo, input, channelId, clearDraft, router]);

  const dismissThreadSuggestion = useCallback(() => {
    if (!replyTo) return;
    const rootId = replyTo.rootId;
    setDismissedThreadSuggestions((prev) => new Set(prev).add(rootId));
  }, [replyTo]);

  /** Scroll to a message (e.g. the original of a reply) if it's loaded. */
  // The message a reply's quote jumped to, tinted for a moment so it is clear
  // which one it was, as Discord does.
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const jumpToMessage = useCallback((messageId: string) => {
    const idx = reversedMessages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
      setFlashMessageId(messageId);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlashMessageId(null), JUMP_FLASH_MS);
    } else {
      toast.info(t.channel.originalFurtherBack);
    }
  }, [reversedMessages, toast, t]);

  // As WhatsApp words them: Today, Yesterday, the weekday within the last
  // week, then the date (with the year once it's not this year), in the app's
  // language and starting with a capital.
  const formatDateLabel = useCallback((dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysAgo = Math.round((today.getTime() - msgDay.getTime()) / 86400000);

    if (daysAgo === 0) return t.channel.today;
    if (daysAgo === 1) return t.channel.yesterday;
    let options: Intl.DateTimeFormatOptions;
    if (daysAgo > 1 && daysAgo < 7) options = { weekday: 'long' };
    else if (date.getFullYear() === now.getFullYear()) options = { weekday: 'long', day: 'numeric', month: 'long' };
    else options = { day: 'numeric', month: 'long', year: 'numeric' };
    const label = date.toLocaleDateString(intlLocale, options);
    return label.charAt(0).toLocaleUpperCase(intlLocale) + label.slice(1);
  }, [t, intlLocale]);

  const openImage: OpenImage = (url, origin) => {
    setViewingImageOrigin(origin);
    setViewingImage(url);
  };

  // Tapping a message's avatar or name opens that person's details.
  const openAuthorProfile = (authorId: string) => {
    Keyboard.dismiss();
    router.push({ pathname: '/user/[userId]', params: { userId: authorId } });
  };

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    // With inverted FlatList, data is reversed: index+1 is the chronologically previous message
    const prev = reversedMessages[index + 1];

    if (item.type === 'system') {
      const call = callLog.entries.get(item.id);
      if (!call) return <SystemMessage content={item.content} styles={styles} />;
      const ongoing = call.outcome === null && callLog.openId === item.id && activeCall !== null;
      return (
        <>
          <CallLogCard
            entry={call}
            ongoing={ongoing}
            joinable={ongoing && session?.callId !== activeCall?.callId}
            createdAt={item.createdAt}
            colors={colors}
            styles={styles}
            onJoin={handleStartCall}
          />
          {startsNewDay(item, prev) ? (
            <DateSeparator label={formatDateLabel(item.createdAt)} styles={styles} />
          ) : null}
        </>
      );
    }

    // An optimistic row has no server id yet — nothing to act on.
    const onLongPress = () => {
      if (item.pending) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // The actions sheet is part of this screen (not a native modal), so an open
      // keyboard would cover its lower rows. Close it first.
      Keyboard.dismiss();
      setSelectedMessage(item);
      setShowActions(true);
    };

    const onSwipeReply = () => {
      if (item.pending) return;
      startReply(item);
    };
    const isReplyTarget = replyTo?.messageId === item.id;

    // Show date separator if first message of the day (chronologically)
    const dateSeparator = startsNewDay(item, prev) ? (
      <DateSeparator label={formatDateLabel(item.createdAt)} styles={styles} />
    ) : null;

    const extras = (
      <MessageExtras
        item={item}
        membersMap={membersMap}
        currentUserId={userId ?? ''}
        colors={colors}
        styles={styles}
        onOpenImage={openImage}
        onToggleReaction={handleToggleReaction}
      />
    );

    if (isCompactMessage(item, prev)) {
      return (
        <>
          <SwipeableMessage
            onLongPress={onLongPress}
            onSwipeReply={onSwipeReply}
            highlighted={isReplyTarget}
            flashing={flashMessageId === item.id}
            compact
          >
            <View style={[styles.messageCompact, item.pending && styles.messagePending]}>
              {extras}
            </View>
          </SwipeableMessage>
          {dateSeparator}
        </>
      );
    }

    const replyRef = item.metadata?.replyTo;
    const replyQuote = replyRef ? (
      <ReplyQuote
        replyRef={replyRef}
        membersMap={membersMap}
        styles={styles}
        onJump={jumpToMessage}
      />
    ) : null;
    const threadCount = item.threadReplyCount ?? 0;

    return (
      <>
        <SwipeableMessage
          onLongPress={onLongPress}
          onSwipeReply={onSwipeReply}
          highlighted={isReplyTarget}
          flashing={flashMessageId === item.id}
        >
          <View style={item.pending && styles.messagePending}>
          {replyQuote}
          <View style={[styles.message, replyQuote ? styles.messageAfterQuote : null]}>
            <Pressable
              onPress={() => openAuthorProfile(item.authorId)}
              disabled={!item.authorId}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={item.authorName}
            >
              <MessageAvatar item={item} styles={styles} />
            </Pressable>
            <View style={styles.msgContent}>
              <View style={styles.msgHeader}>
                <Text
                  style={styles.msgAuthor}
                  onPress={item.authorId ? () => openAuthorProfile(item.authorId) : undefined}
                  suppressHighlighting
                >
                  {item.authorName}
                </Text>
                <Text style={styles.msgTime}>
                  {new Date(item.createdAt).toLocaleTimeString(intlLocale, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              {extras}
              {threadCount > 0 && (
                <ThreadLink
                  count={threadCount}
                  colors={colors}
                  styles={styles}
                  onPress={() => openThread(item)}
                />
              )}
            </View>
          </View>
          </View>
        </SwipeableMessage>
        {dateSeparator}
      </>
    );
  };

  // The list item's name covers the gap until the channel request answers.
  const channelName: string = channel?.name || initialName || '';
  const channelType: string | undefined = channel?.type ?? initialType;
  const isPrivate = channelType === 'private';
  const isDm = channelType === 'dm';
  const isArchived = channel?.isArchived === true;
  // A call is already in progress (possibly minimized) → block starting another.
  const inCall = !!session;

  const handleStartCall = useCallback(
    async (callType: 'voice' | 'video') => {
      // Down before the call screen slides up, not after the request answers.
      Keyboard.dismiss();
      try {
        // If a call is already running in this channel, join it instead of
        // starting a new one. (The backend's start-and-join is idempotent too,
        // so this is also race-safe.)
        // Hand the call screen who it is with, on both the start and join-active
        // paths: the person for a DM, the channel's name otherwise.
        const peer = isDm
          ? { name: channelName, avatar: channel?.picture, isDirect: true }
          : { name: channelName ? `#${channelName}` : undefined };
        if (activeCall) {
          await joinCall(activeCall.callId, peer);
        } else {
          await startCall(channelId, callType, peer);
        }
      } catch {
        Alert.alert(t.channel.callFailedTitle, t.channel.callFailedBody);
      }
    },
    [activeCall, joinCall, startCall, channelId, isDm, channelName, channel?.picture, t],
  );

  const handleUnarchive = useCallback(async () => {
    try {
      await appApi.chatDm.unarchive(channelId);
      router.back();
    } catch (err) {
      console.error(err);
    }
  }, [channelId, router]);

  const [pinnedIndex, setPinnedIndex] = useState(0);
  const pinnedPosition = pinnedPositionFor(pinnedIndex, pinnedMessages.length);
  const currentPinned: Message | undefined = pinnedMessages[pinnedPosition];

  // Presence subtitle under the DM peer's name. We only have the roster's
  // membership status (no real last-seen timestamp), so this is "Active now"
  // for ACTIVE members and "Offline" otherwise — consistent with the profile screen.
  const peerIsOnline = useMemo(() => {
    if (!isDm) return null;
    let peerId = channel?.otherUserId ?? undefined;
    if (!peerId && channelName) {
      for (const [uid, name] of membersMap.entries()) {
        if (name === channelName) { peerId = uid; break; }
      }
    }
    if (!peerId) return null;
    return memberStatus.get(peerId) === 'ACTIVE';
  }, [isDm, channel?.otherUserId, channelName, membersMap, memberStatus]);

  const openPeerProfile = () => {
    if (!isDm) return;
    // Prefer otherUserId from backend; fall back to looking it up by
    // matching the DM display name against workspace members.
    let targetUserId: string | undefined = channel?.otherUserId;
    if (!targetUserId && channelName) {
      for (const [uid, name] of membersMap.entries()) {
        if (name === channelName) { targetUserId = uid; break; }
      }
    }
    if (targetUserId) router.push(`/user/${targetUserId}` as any);
  };

  const openChannelInfo = () => {
    router.push({
      pathname: '/channel-info/[channelId]',
      params: { channelId, name: channelName },
    } as never);
  };

  const handlePinnedBarPress = () => {
    if (!currentPinned) return;
    if (pinnedMessages.length > 1) {
      setPinnedIndex((i) => i + 1);
    }
    const idx = reversedMessages.findIndex((m) => m.id === currentPinned.id);
    if (idx >= 0) {
      flatListRef.current?.scrollToIndex({ index: idx, animated: true });
    }
  };

  // The bar's X unpins for everyone in the channel, so it asks first.
  const handleUnpinCurrent = () => {
    const msg = currentPinned;
    if (!msg) return;
    Alert.alert(t.channel.unpinTitle, t.channel.unpinBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.channel.unpin,
        style: 'destructive',
        onPress: () => {
          setLocalPinnedIds((prev) => { const next = new Set(prev); next.delete(msg.id); return next; });
          setMessages((prev) => prev.map((m) => m.id === msg.id ? { ...m, isPinned: false } : m));
          appApi.chatMessages.unpin(msg.id).then(() => loadMessages()).catch(console.error);
        },
      },
    ]);
  };

  const handleInputChange = (text: string) => {
    setInput(text);
    if (text.length > 0) onKeystroke();
    // Draft autosave (skip in edit mode — we're editing an existing message)
    if (!editingMessage) {
      if (text.trim().length > 0) {
        saveDraft(text);
      } else {
        // Input cleared — delete the draft
        void clearDraft();
      }
    }
    setMentionQuery(detectMentionQuery(text));
  };

  const canSend = hasSendableContent(input, pendingFiles);
  const composerConnected = hasComposerContext({
    editing: !!editingMessage,
    fileCount: pendingFiles.length,
    typingCount: typingUsers.length,
  });

  return (
    <View style={styles.container}>
      {/* Header */}
      {!hideHeader && (
        <ChannelHeader
          hideBackButton={hideBackButton}
          isDm={isDm}
          isPrivate={isPrivate}
          channelName={channelName}
          picture={channel?.picture}
          peerIsOnline={peerIsOnline}
          inCall={inCall}
          joinableCall={activeCall && session?.callId !== activeCall.callId ? activeCall.callType : null}
          identityEnabled={isDm || channel !== null}
          colors={colors}
          styles={styles}
          onBack={() => router.back()}
          onOpenIdentity={isDm ? openPeerProfile : openChannelInfo}
          onStartCall={handleStartCall}
        />
      )}


      {/* Pinned message bar */}
      <PinnedBar
        current={currentPinned}
        count={pinnedMessages.length}
        position={pinnedPosition}
        colors={colors}
        styles={styles}
        onPress={handlePinnedBarPress}
        onUnpin={handleUnpinCurrent}
      />

      {/* Messages — wrapped so the list shrinks when the keyboard appears,
          keeping the input bar's distance from the latest message constant. */}
      <Animated.View style={[styles.listContainer, listContainerStyle]}>
        <FlatList
          ref={flatListRef}
          data={reversedMessages}
          inverted
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={<Animated.View style={listHeaderSpacerStyle} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScroll={(e) => {
            // Inverted list: bottom (newest) is offset 0; offset grows as you
            // scroll up. Reveal the jump-to-bottom button past a short threshold.
            setShowScrollToBottom(e.nativeEvent.contentOffset.y > 320);
          }}
          scrollEventThrottle={32}
          onScrollToIndexFailed={(info) => {
            // Rows have variable heights: scroll near the target first, then
            // retry once it has been laid out.
            flatListRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: true,
            });
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
            }, 250);
          }}
          // Inverted: the list's end is the oldest message, at the top.
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.5}
          onContentSizeChange={(_, height) => {
            contentHeightRef.current = height;
            fillScreenWithHistory();
          }}
          ListFooterComponent={
            loadingOlder ? <ActivityIndicator style={styles.olderLoader} color={colors.muted} /> : null
          }
          initialNumToRender={20}
          maxToRenderPerBatch={10}
          windowSize={10}
          removeClippedSubviews
          ListEmptyComponent={
            <EmptyChannel
              isDm={isDm}
              channelName={channelName}
              loading={messagesLoading || (channel === null && !channelName)}
              colors={colors}
              styles={styles}
            />
          }
        />
      </Animated.View>

      <KeyboardStickyView
        style={[styles.bottomStack, composerConnected && styles.bottomStackSolid]}
        pointerEvents="box-none"
        offset={{ closed: 0, opened: insets.bottom }}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          // Record the measured height as the endpoint for the current state.
          // The spacer interpolates between these on the keyboard's progress.
          if (isInputExpanded) {
            expandedStackHeightSV.value = h;
          } else {
            collapsedStackHeightSV.value = h;
          }
        }}
      >
      {/* Jump-to-newest button — floats just above the composer, moving with
          the keyboard since it lives inside the sticky bottom stack. */}
      {showScrollToBottom && (
        <TouchableOpacity
          style={styles.scrollToBottomBtn}
          activeOpacity={0.85}
          onPress={scrollToBottom}
          accessibilityLabel={t.channel.scrollToLatest}
        >
          <ChevronDown size={21} color={colors.text} strokeWidth={2.5} />
        </TouchableOpacity>
      )}
      {/* Mention picker — lives in the keyboard-sticky stack so it sits right
          above the composer. Rendered in the page flow it ended up behind the
          absolutely positioned composer and the keyboard, i.e. invisible. */}
      <MentionPicker
        query={mentionQuery ?? ''}
        visible={mentionQuery !== null && !showRecordingBar}
        onSelect={(member) => {
          setInput((prev) => insertMention(prev, member.userId));
          setMentionQuery(null);
        }}
      />
      {/* Edit mode banner */}
      <EditBar
        active={!!editingMessage}
        colors={colors}
        styles={styles}
        onClose={() => {
          setEditingMessage(null);
          setInput(draftBeforeEditRef.current);
          draftBeforeEditRef.current = '';
        }}
      />

      {/* Long reply chain → suggest continuing in a thread (Discord-style) */}
      <ThreadSuggestion
        visible={showThreadSuggestion}
        colors={colors}
        styles={styles}
        onContinue={continueInThread}
        onDismiss={dismissThreadSuggestion}
      />

      {/* Pending files */}
      <PendingFiles
        files={pendingFiles}
        onRemove={(i) => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
      />

      {/* Typing indicator */}
      <TypingIndicator typingUsers={typingUsers} membersMap={membersMap} styles={styles} />

      {/* Archived banner or input bar */}
      <Composer
        isArchived={isArchived}
        isRecording={showRecordingBar}
        isSendingVoice={sendingVoiceMs !== null}
        isInputExpanded={isInputExpanded}
        meteringDb={meteringDb}
        recordingMs={sendingVoiceMs ?? durationMs}
        input={input}
        isDm={isDm}
        channelName={channelName}
        members={membersMap}
        uploading={uploading}
        canSend={canSend}
        colors={colors}
        styles={styles}
        inputRef={inputRef}
        inputScrollRef={inputScrollRef}
        inputContentHeightRef={inputContentHeightRef}
        inputUserScrollingRef={inputUserScrollingRef}
        onChangeText={handleInputChange}
        onFocusInput={() => setIsInputFocused(true)}
        onBlurInput={() => setIsInputFocused(false)}
        onAttach={handleAttach}
        onSend={handleSend}
        onStartRecording={handleStartRecording}
        onCancelRecording={handleCancelRecording}
        onSendRecording={handleSendRecording}
        header={
          replyTo ? (
            <ReplyHeader
              replyTo={replyTo}
              colors={colors}
              styles={styles}
              onClose={() => setReplyTo(null)}
            />
          ) : undefined
        }
        barStyle={composerBarStyle}
        bottomInset={insets.bottom}
        onUnarchive={handleUnarchive}
      />
      </KeyboardStickyView>

      {/* Message actions bottom sheet */}
      <MessageActions
        visible={showActions}
        message={selectedMessage}
        onClose={() => { setShowActions(false); setSelectedMessage(null); }}
        onReply={() => {
          if (selectedMessage) startReply(selectedMessage);
        }}
        onReact={() => {
          setReactionTarget(selectedMessage);
          setShowEmojiPicker(true);
        }}
        onThread={() => selectedMessage && openThread(selectedMessage)}
        onPin={handlePin}
        onCopy={() => {
          if (!selectedMessage) return;
          Clipboard.setString(mentionsToPlainText(selectedMessage.content, membersMap));
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(t.channel.copied);
        }}
        onQuickReact={handleReaction}
        onSave={handleSaveMessage}
        onEdit={() => {
          if (selectedMessage) {
            if (!editingMessage) draftBeforeEditRef.current = input;
            setEditingMessage(selectedMessage);
            setInput(selectedMessage.content);
            focusComposer();
          }
        }}
        onDelete={handleDeleteMessage}
        isOwnMessage={selectedMessage?.authorId === userId}
      />

      {/* Emoji picker */}
      <EmojiPicker
        visible={showEmojiPicker}
        onClose={() => {
          setShowEmojiPicker(false);
          setReactionTarget(null);
        }}
        onSelect={handleEmojiSelect}
      />

      {/* In-app image viewer */}
      <ImageViewer
        images={conversationImages}
        initialUrl={viewingImage}
        origin={viewingImageOrigin}
        onClose={() => setViewingImage(null)}
      />

      {/* Pin duration picker */}
      <PinDurationModal
        visible={showPinDuration}
        pinDuration={pinDuration}
        colors={colors}
        styles={styles}
        onRequestClose={() => setShowPinDuration(false)}
        onDismiss={() => { setShowPinDuration(false); setPinDuration(null); setMessageToPin(null); }}
        onSelectDuration={handleSelectDuration}
        onConfirm={handlePinConfirm}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      paddingTop: topInset,
      backgroundColor: c.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    // Fixed-height content row so the back/avatar/actions stay vertically
    // centered regardless of the top inset (matters when a minimized call
    // shrinks the inset — content would otherwise sit low / look cramped).
    headerContent: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 56,
      paddingLeft: 4,
      paddingRight: 6,
    },
    // iPad split view has no back button; keep the tile off the edge.
    headerContentNoBack: { paddingLeft: 16 },
    backBtn: {
      width: 40,
      height: 44,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerIdentity: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      paddingRight: 8,
    },
    headerIdentityText: {
      flex: 1,
      justifyContent: 'center',
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: '600',
      letterSpacing: -0.3,
      color: c.text,
      lineHeight: 21,
    },
    headerSubtitle: { fontSize: 13, color: c.mutedForeground, lineHeight: 16, marginTop: 1 },
    // Same size and radius as the DM list avatars.
    headerAvatarWrap: { width: 36, height: 36 },
    headerAvatar: { width: 36, height: 36, borderRadius: 13 },
    headerAvatarFallback: {
      width: 36,
      height: 36,
      borderRadius: 13,
      backgroundColor: BRAND,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerAvatarText: { fontSize: 15, fontWeight: '600', color: '#fff' },
    headerPresenceDot: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: c.background,
      backgroundColor: ACCENTS.online,
    },
    headerChannelIcon: {
      width: 24,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerAction: {
      width: 42,
      height: 44,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerActionDisabled: { opacity: 0.35 },
    headerJoin: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      height: 34, paddingHorizontal: 14, borderRadius: 13, marginRight: 10,
      backgroundColor: BRAND,
    },
    headerJoinText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    pinnedBar: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: 16, paddingVertical: 10,
      backgroundColor: c.background,
      borderBottomWidth: 1, borderBottomColor: c.secondary,
    },
    pinnedLineContainer: { width: 3, alignSelf: 'stretch', borderRadius: 2, gap: 2, overflow: 'hidden' },
    pinnedLineSegment: { flex: 1, borderRadius: 2 },
    pinnedContent: { flex: 1 },
    pinnedAuthor: { fontSize: 12, fontWeight: '700', color: BRAND },
    pinnedCount: { fontSize: 11, fontWeight: '500', color: c.muted },
    pinnedText: { fontSize: 13, color: c.mutedForeground, marginTop: 1 },
    listContainer: { flex: 1 },
    olderLoader: { marginVertical: 16 },
    list: {
      paddingHorizontal: 16,
      // No paddingTop here: the visual bottom padding of the inverted list is
      // produced by the *animated* marginBottom on the Animated.View wrapper, so it
      // can interpolate smoothly when the composer grows / shrinks.
      paddingBottom: 8,
      // No flexGrow: the inverted list already keeps a short conversation at
      // the bottom, right above the composer (as in WhatsApp), and a content
      // area no taller than its messages lets onEndReached see that a short
      // first page doesn't fill the screen and fetch older messages.
    },
    // Top-only margins so spacing doesn't double-count (prev row's bottom margin
    // + this row's top margin). New-group messages get a clear gap; consecutive
    // same-author (compact) messages sit tightly under the first one.
    message: { flexDirection: 'row', marginTop: 12, marginBottom: 0 },
    messageCompact: { paddingLeft: 42, marginTop: 3, marginBottom: 0 },
    messagePending: { opacity: 0.55 },
    messageAfterQuote: { marginTop: 4 },
    // Discord-style quote of the replied-to message, above the reply's header.
    // It starts in the name column (16 + 32 avatar + 10); the spine leaves the
    // avatar's centre just above it, runs up to the middle of the quote and
    // stops 4pt short of the quote's avatar.
    replyQuote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginTop: 12,
      paddingLeft: 42,
      paddingRight: 8,
      minHeight: 20,
    },
    replyQuoteSpine: {
      position: 'absolute',
      left: 15.25,
      top: 9.25,
      bottom: -2,
      width: 22.75,
      borderLeftWidth: 1.5,
      borderTopWidth: 1.5,
      borderTopLeftRadius: 6,
      borderColor: c.mutedForeground + '66',
    },
    replyQuoteAvatar: { width: 16, height: 16, borderRadius: 6 },
    replyQuoteAvatarFallback: { backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' },
    replyQuoteAvatarText: { fontSize: 9, fontWeight: '700', color: '#fff' },
    replyQuoteAuthor: { fontSize: 14, fontWeight: '600', color: c.text, maxWidth: '40%' },
    replyQuoteText: { flex: 1, fontSize: 14, color: c.mutedForeground },
    messagePressed: { backgroundColor: c.cardBackground, marginHorizontal: -16, paddingHorizontal: 16 },
    dateSeparator: {
      flexDirection: 'row', alignItems: 'center', marginVertical: 16, gap: 12,
    },
    dateLine: { flex: 1, height: 1, backgroundColor: c.border + '99' },
    dateLabel: { fontSize: 12, fontWeight: '600', color: c.muted },
    systemMessage: {
      alignItems: 'center', marginVertical: 12,
    },
    systemText: {
      fontSize: 13, color: c.mutedForeground, fontWeight: '500',
      backgroundColor: c.secondary,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
      paddingHorizontal: 12, paddingVertical: 6,
      borderRadius: 9, overflow: 'hidden',
    },
    // Call events (made = green, missed = red) — tint applied inline.
    // Discord's call card: 16pt apart, icon column, two lines, avatar.
    callCard: {
      flexDirection: 'row', alignItems: 'center',
      marginVertical: 8, minHeight: 58,
      paddingVertical: 10, paddingLeft: 16, paddingRight: 12,
      borderRadius: 8,
      backgroundColor: c.secondary,
    },
    callCardIcon: { width: 24, height: 24, marginRight: 12, alignItems: 'center', justifyContent: 'center' },
    callCardText: { flex: 1, minWidth: 0 },
    callCardTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600', color: c.text },
    callCardMeta: { fontSize: 14, lineHeight: 18, color: c.mutedForeground, marginTop: 1 },
    callCardAvatar: { width: 24, height: 24, borderRadius: 8, marginLeft: 12 },
    callCardAvatarFallback: { backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' },
    callCardAvatarInitial: { fontSize: 12, fontWeight: '700', color: '#fff' },
    callCardJoin: {
      height: 32, paddingHorizontal: 14, marginLeft: 12, borderRadius: 8,
      backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center',
    },
    callCardJoinText: { color: '#fff', fontSize: 15, fontWeight: '600' },

    // Floating circular "jump to newest" button, pinned just above the composer.
    scrollToBottomBtn: {
      position: 'absolute',
      bottom: '100%',
      alignSelf: 'center',
      marginBottom: 10,
      width: 38,
      height: 38,
      borderRadius: 19,
      // Solid, so the messages don't show through it.
      backgroundColor: c.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.18,
      shadowRadius: 6,
      elevation: 4,
    },
    msgAvatarImg: { width: 32, height: 32, borderRadius: 12, marginRight: 10, marginTop: 1 },
    msgAvatar: {
      width: 32, height: 32, borderRadius: 12,
      backgroundColor: BRAND, justifyContent: 'center', alignItems: 'center', marginRight: 10, marginTop: 1,
    },
    msgAvatarText: { fontSize: 15, fontWeight: '700', color: '#fff' },
    msgContent: { flex: 1 },
    msgHeader: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 1 },
    msgAuthor: { fontSize: 14.5, fontWeight: '600', color: c.text, marginRight: 8 },
    msgTime: { fontSize: 12, color: c.muted },
    threadLink: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, minHeight: 32, paddingVertical: 2 },
    threadText: { fontSize: 13, color: c.info, fontWeight: '500' },
    empty: { padding: 16 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 4 },
    emptyText: { fontSize: 14, color: c.muted },
    archivedBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 16, paddingVertical: 12,
      backgroundColor: c.cardBackground,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.secondary,
    },
    archivedText: { flex: 1, fontSize: 14, color: c.muted },
    unarchiveBtn: {
      paddingHorizontal: 12, paddingVertical: 6,
      backgroundColor: BRAND, borderRadius: 8,
    },
    unarchiveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
    // Composer geometry is measured from the ChatGPT iOS composer: a 48pt pill
    // inset 38pt from the sides and bottom while idle, a card inset 12pt and
    // sitting 12pt above the keyboard while typing. The plus and the send
    // button are centred 24pt in from the edges; the mic sits 40pt from send.
    // Side and bottom insets are animated between those two (composerBarStyle).
    inputBar: { paddingTop: 0 },
    inputBarHidden: { display: 'none' },
    // Transparent, so the messages scroll on behind the floating composer.
    bottomStack: {
      position: 'absolute',
      bottom: 0, left: 0, right: 0,
    },
    // A reply/edit/file/typing row sits above the composer: give the stack a
    // solid floor so the row and the composer read as one block.
    bottomStackSolid: { backgroundColor: c.background },
    editBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: c.cardBackground,
      gap: 8,
    },
    editBarLabel: {
      flex: 1,
      fontSize: 13,
      color: BRAND,
      fontWeight: '600',
    },
    editBarClose: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editedLabel: {
      fontSize: 12,
      color: c.muted,
      fontStyle: 'italic',
      marginTop: 2,
    },
    threadSuggest: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: c.cardBackground,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    threadSuggestText: { flex: 1, fontSize: 13, color: c.text },
    threadSuggestBtn: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: BRAND,
    },
    threadSuggestBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
    // The reply row inside the composer card (Discord's layout).
    replyHeaderLabel: { flex: 1, minWidth: 0, fontSize: 15, color: c.mutedForeground },
    replyHeaderName: { fontWeight: '700', color: c.text },
    replyHeaderClose: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    attachmentList: { marginTop: 6, gap: 6 },
    attachmentImage: {
      width: '100%' as any, maxWidth: 280, aspectRatio: 4 / 3, borderRadius: 8, backgroundColor: c.cardBackground,
    },
    attachmentFile: {
      flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8,
      backgroundColor: c.cardBackground, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 10, maxWidth: 250,
    },
    attachmentFileInfo: { flex: 1 },
    attachmentFileName: { fontSize: 13, fontWeight: '600' as const, color: c.text },
    attachmentFileSize: { fontSize: 11, color: c.muted, marginTop: 1 },
    typingRow: {
      paddingHorizontal: 16, paddingVertical: 4, backgroundColor: c.background,
    },
    typingText: { fontSize: 12, color: c.muted, fontStyle: 'italic' },
    pinDurationBackdrop: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end',
    },
    pinDurationSheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: 14, borderTopRightRadius: 14,
      paddingBottom: 8 + bottomInset,
    },
    pinDurationHandle: { alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
    pinDurationHandleBar: { width: 36, height: 5, borderRadius: 3, backgroundColor: c.secondary },
    pinDurationTitle: {
      fontSize: 15, fontWeight: '700', color: c.text,
      paddingHorizontal: 20, paddingBottom: 8,
    },
    pinDurationOption: {
      flexDirection: 'row', alignItems: 'center', gap: 14,
      paddingVertical: 14, paddingHorizontal: 20,
    },
    pinDurationOptionPressed: { backgroundColor: c.secondary },
    pinDurationOptionText: { fontSize: 16, color: c.text },
    pinOptionContent: { flex: 1 },
    pinOptionDesc: { fontSize: 13, color: c.muted, marginTop: 1 },
  });
