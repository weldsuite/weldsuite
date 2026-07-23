import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  Clipboard,
  Keyboard,
  Modal,
  Pressable,
  Alert,
  ActivityIndicator,
  Platform,
  ScrollView,
} from 'react-native';
import { useOrganization } from '@clerk/expo';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS, interpolate, Extrapolation } from 'react-native-reanimated';
import { Gesture, GestureDetector, FlatList } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useAuth } from '@clerk/expo';
import { Archive, ArrowUp, AtSign, AudioLines, Bell, BellOff, ChevronDown, ChevronLeft, Clock, FileText, Hash, Infinity as InfinityIcon, Lock, MessageSquare, MoreVertical, Paperclip, Pencil, Phone, PhoneMissed, Pin, Plus, Reply, X } from 'lucide-react-native';
import { VideoCameraIcon } from '@/components/icons/VideoCameraIcon';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { useCall } from '@/contexts/CallContext';
import { useChatRealtime } from '@/hooks/useChatRealtime';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { openExternalUrl } from '@/utils/safe-url';
import { ReactionBar } from './ReactionBar';
import { MessageActions } from './MessageActions';
import { EmojiPicker } from './EmojiPicker';
import { MentionPicker } from './MentionPicker';
import { AudioPlayer } from './AudioPlayer';
import { ImageViewer } from './ImageViewer';
import { appApi, appApiClient } from '@/services/app-api';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

interface ChatAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

/** React Native file descriptor produced by the document/image pickers. */
type RNFile = { name: string; uri: string; mimeType: string };

/**
 * Upload a picked RN file to app-api and map the response to a ChatAttachment.
 * The shared `upload` domain types its argument as `File`; React Native's
 * FormData accepts the `{ uri, type, name }` descriptor at runtime, so the
 * descriptor is cast through `unknown`. Returns null on failure.
 */
async function uploadChatAttachment(
  channelId: string,
  file: RNFile,
): Promise<ChatAttachment | null> {
  try {
    const rnFile = { uri: file.uri, type: file.mimeType, name: file.name };
    const res = await appApi.chatMessages.upload(rnFile as unknown as File, channelId);
    // The server returns `{ id, fileName, fileSize, mimeType, url, fileKey }`
    // (the upload service result); the shared response type omits `id`.
    return res.data as unknown as ChatAttachment;
  } catch (err) {
    console.error('[WeldChat] uploadChatAttachment failed:', err);
    return null;
  }
}

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
}

/** Render message text with <@userId> mention badges */
function renderMessageText(content: string, members: Map<string, string>, colors: ColorScheme) {
  const mentionRegex = /<@([^>]+)>/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`t${match.index}`} style={{ fontSize: 15, lineHeight: 22, color: colors.textPrimary }}>{content.substring(lastIndex, match.index)}</Text>);
    }
    const uid = match[1];
    const name = uid.includes(':') ? uid.split(':')[1] : (members.get(uid) ?? uid);
    parts.push(
      <Text key={`m${match.index}`} style={{ fontSize: 14, fontWeight: '700', color: '#dee0fc', backgroundColor: 'rgba(88, 101, 242, 0.3)', borderRadius: 4, paddingHorizontal: 2, overflow: 'hidden' }}>@{name}</Text>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(<Text key="end" style={{ fontSize: 15, lineHeight: 22, color: colors.textPrimary }}>{content.substring(lastIndex)}</Text>);
  }

  if (parts.length === 0) {
    return <Text style={{ fontSize: 15, lineHeight: 22, color: colors.textPrimary }}>{content}</Text>;
  }

  return <Text style={{ fontSize: 15, lineHeight: 22, color: colors.textPrimary }}>{parts}</Text>;
}

/** Check if text contains <@...> mention tokens */
function hasMentionTokens(text: string): boolean {
  return /<@[^>]+>/.test(text);
}

/**
 * Classify a `type: 'system'` message that represents a call event so it can be
 * themed green (made/connected) or red (missed) in the conversation, à la
 * WhatsApp. Backend content strings: "<name> started a voice/video call",
 * "Call ended — 2:34", "Missed call". Returns null for non-call system rows.
 */
function classifyCallSystemMessage(content: string): { kind: 'missed' | 'made'; isVideo: boolean } | null {
  const text = content.toLowerCase();
  if (!text.includes('call')) return null;
  const isVideo = text.includes('video call');
  if (text.includes('missed call')) return { kind: 'missed', isVideo };
  if (text.includes('started a') || text.includes('call ended')) return { kind: 'made', isVideo };
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Render input text with inline mention badges (overlay on TextInput) */
function renderInputWithBadges(text: string, members: Map<string, string>, colors: ColorScheme) {
  const mentionRegex = /<@([^>]+)>/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={`t${match.index}`} style={{ fontSize: 16, color: colors.textPrimary }}>
          {text.substring(lastIndex, match.index)}
        </Text>
      );
    }
    const uid = match[1];
    const name = uid.includes(':') ? uid.split(':')[1] : (members.get(uid) ?? uid);
    parts.push(
      <Text key={`m${match.index}`} style={{ fontSize: 15, fontWeight: '700', color: '#dee0fc', backgroundColor: 'rgba(88, 101, 242, 0.3)', borderRadius: 4, paddingHorizontal: 3, overflow: 'hidden' }}>@{name}</Text>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <Text key="end" style={{ fontSize: 16, color: colors.textPrimary }}>
        {text.substring(lastIndex)}
      </Text>
    );
  }

  return <Text style={{ fontSize: 16, color: colors.textPrimary }}>{parts}</Text>;
}

/** Live audio waveform driven by the recorder's meter (dB). Bars shift left
 *  each tick; the newest bar is sized by the current input level. Silent
 *  input → all bars collapse to a flat baseline. */
function Waveform({ active, color, level }: { active: boolean; color: string; level: number }) {
  const BAR_COUNT = 56;
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    if (!active) {
      setBars(Array(BAR_COUNT).fill(0));
      return;
    }
    const id = setInterval(() => {
      setBars((prev) => {
        // Map dB (-60..0) to 0..1; ignore anything below -60 (effectively silence).
        const db = levelRef.current;
        const norm = Math.max(0, Math.min(1, (db + 60) / 60));
        // Add a touch of jitter so the newest bar still feels alive, but only
        // proportional to the current level (so silence stays flat).
        const jitter = (Math.random() - 0.5) * 0.15 * norm;
        const next = Math.max(0, Math.min(1, norm + jitter));
        return [...prev.slice(1), next];
      });
    }, 60);
    return () => clearInterval(id);
  }, [active]);

  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 32, paddingHorizontal: 4 }}>
      {bars.map((v, i) => (
        <View
          key={i}
          style={{
            width: 2,
            height: Math.max(2, v * 26),
            borderRadius: 1,
            backgroundColor: color,
            opacity: 0.75,
          }}
        />
      ))}
    </View>
  );
}

/**
 * Wraps a message row to add Discord-style swipe-left-to-reply.
 * Composes a LongPress (existing action sheet) with a Pan that activates
 * only on horizontal left motion, vertical motion yields to FlatList scroll,
 * right motion yields to the stack's swipe-back gesture.
 */
function SwipeableMessage({
  onLongPress,
  onSwipeReply,
  children,
}: {
  onLongPress: () => void;
  onSwipeReply: () => void;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
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
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSwipeReply();
  };

  const longPress = Gesture.LongPress()
    .minDuration(450)
    .maxDistance(10)
    .onStart(() => {
      pressed.value = withTiming(1, { duration: 120 });
      runOnJS(onLongPress)();
    })
    .onFinalize(() => {
      pressed.value = withTiming(0, { duration: 180 });
    });

  const pan = Gesture.Pan()
    .activeOffsetX([-15, 9999])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      const next = Math.max(-MAX, Math.min(0, e.translationX));
      const past = next <= -TRIGGER;
      if (past && !crossedThreshold.value) {
        crossedThreshold.value = true;
        runOnJS(fireHaptic)();
      } else if (!past && crossedThreshold.value) {
        crossedThreshold.value = false;
      }
      translateX.value = next;
    })
    .onEnd(() => {
      if (crossedThreshold.value) {
        runOnJS(fireReply)();
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
    const past = translateX.value <= -TRIGGER ? 1 : 0;
    return {
      opacity: progress,
      transform: [
        { translateX: Math.max(-MAX, translateX.value) },
        { scale: 0.5 + progress * 0.5 + past * 0.1 },
      ],
    };
  });

  return (
    <GestureDetector gesture={composed}>
      <View>
        <Animated.View
          pointerEvents="none"
          style={[swipeReplyStyles.pressHighlight, { backgroundColor: colors.bgSecondary }, highlightStyle]}
        />
        <Animated.View pointerEvents="none" style={[swipeReplyStyles.iconWrap, iconStyle]}>
          <View style={[swipeReplyStyles.iconBubble, { backgroundColor: colors.bgSecondary }]}>
            <Reply size={20} color={colors.textPrimary} strokeWidth={2} />
          </View>
        </Animated.View>
        <Animated.View style={messageStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

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
  iconWrap: {
    position: 'absolute',
    right: 16,
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

interface ChannelViewProps {
  channelId: string;
  hideBackButton?: boolean;
  hideHeader?: boolean;
}

export function ChannelView({ channelId, hideBackButton, hideHeader }: ChannelViewProps) {
  const { userId } = useAuth();
  const { organization } = useOrganization();
  const workspaceId = organization?.id ?? null;
  const toast = useToast();
  const { startCall, joinCall, activeChannelCalls, setChannelActiveCall, session } = useCall();
  const router = useRouter();
  const { colors, mode } = useTheme();
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
  const [input, setInput] = useState('');
  const [channel, setChannel] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [viewingImageOrigin, setViewingImageOrigin] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [showPinDuration, setShowPinDuration] = useState(false);
  const [pinDuration, setPinDuration] = useState<string | null>(null);
  const [messageToPin, setMessageToPin] = useState<Message | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentions, setMentions] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<Array<{ name: string; uri: string; mimeType: string }>>([]);
  const [replyTo, setReplyTo] = useState<{ messageId: string; authorId: string; authorName: string; content: string } | null>(null);
  const [replyMention, setReplyMention] = useState(true);
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

  const isInputExpanded =
    isInputFocused || input.length > 0 || pendingFiles.length > 0 || replyTo !== null;

  // Mirror the expanded state into a shared value so the list reservation can
  // floor itself at the real composer height (see listHeaderSpacerStyle).
  // Plain assignment (no timing) keeps the keyboard-open transition bounce-free.
  useEffect(() => {
    inputExpandedSV.value = isInputExpanded ? 1 : 0;
  }, [isInputExpanded, inputExpandedSV]);

  // The expanded TextInput uses `autoFocus`, so it grabs focus the instant it
  // mounts — no setTimeout tick, no perceptible delay when the user taps the
  // collapsed placeholder to expand the composer.

  const { isRecording, meteringDb, startRecording, stopRecording } = useVoiceRecorder();

  // Load workspace members for mention resolution
  useEffect(() => {
    (async () => {
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
  const { typingUsers, onKeystroke, onSend, client } = useChatRealtime(channelId, loadMessages);

  const openAttachmentPicker = useCallback(() => {
    Alert.alert('Attach', undefined, [
      {
        text: 'Photo Library',
        onPress: async () => {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            quality: 0.8,
          });
          if (!result.canceled && result.assets) {
            setPendingFiles((prev) => [
              ...prev,
              ...result.assets.map((a) => ({
                name: a.fileName || `photo_${Date.now()}.jpg`,
                uri: a.uri,
                mimeType: a.mimeType || 'image/jpeg',
              })),
            ]);
          }
        },
      },
      {
        text: 'File',
        onPress: async () => {
          const result = await DocumentPicker.getDocumentAsync({ multiple: true });
          if (!result.canceled && result.assets) {
            setPendingFiles((prev) => [
              ...prev,
              ...result.assets.map((a) => ({
                name: a.name,
                uri: a.uri,
                mimeType: a.mimeType || 'application/octet-stream',
              })),
            ]);
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

  const handleStartRecording = useCallback(async () => {
    await startRecording();
  }, [startRecording]);

  const handleCancelRecording = useCallback(async () => {
    await stopRecording();
  }, [stopRecording]);

  const handleSendRecording = useCallback(async () => {
    const result = await stopRecording();
    if (!result) return;
    try {
      const uploaded = await uploadChatAttachment(channelId, result);
      if (!uploaded) return;
      await appApi.chatMessages.create({ channelId, body: '', attachments: [uploaded] });
      loadMessages();
      onSend();
    } catch (err) {
      console.error('[WeldChat] Voice message send failed:', err);
    }
  }, [stopRecording, channelId, onSend]);

  useEffect(() => {
    setMessages([]);
    setChannel(null);
    setInput('');
    setEditingMessage(null);
    draftIdRef.current = null;
    loadChannel();
    loadMessages();
    // Load draft for this channel if composer is empty. The server scopes
    // drafts to the authenticated caller (JWT) — no client-supplied userId.
    if (userId) {
      appApiClient.get<{ data: Array<{ id: string; content: string }> }>(
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

  function loadMessages() {
    appApi.chatMessages.list({ channelId }).then((res) => {
      const raw = res.data ?? [];
      const msgs: Message[] = Array.isArray(raw) ? (raw as unknown as Message[]) : [];
      const merged = msgs.map((m) => ({
        ...m,
        isPinned: m.isPinned || localPinnedIds.has(m.id),
      }));
      setMessages((prev) => {
        const localSystemMsgs = prev.filter((m) => m.type === 'system' && m.id.startsWith('pin-'));
        return [...merged, ...localSystemMsgs];
      });
      // We're viewing this channel, so mark it read — advances our lastReadAt
      // past the latest message (incl. one we just sent). Without this the
      // channel keeps rendering as "unread" (tinted row + accent timestamp) in
      // the DM list. Fire-and-forget; the list refetches on the resulting event.
      appApi.channels.markRead(channelId).catch(() => {});
    }).catch(console.error);
  }

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
    setInput('');
    setEditingMessage(null);
    try {
      await appApi.chatMessages.update(msgId, { content: trimmed });
      loadMessages();
    } catch (err) {
      console.error('[WeldChat] Edit failed:', err);
      // Revert on failure
      loadMessages();
    }
  }, [editingMessage, input]);

  const handleSend = useCallback(async () => {
    // If in edit mode, submit the edit instead
    if (editingMessage) {
      await handleEditSubmit();
      return;
    }

    if ((!input.trim() && pendingFiles.length === 0) || sending || uploading) return;
    setSending(true);
    try {
      const trimmed = input.trim();

      // Handle /ask slash command — the AI chat agent has been removed along
      // with the AI backend, so surface an unavailable notice instead of
      // calling the (removed) endpoint.
      if (trimmed.startsWith('/ask ')) {
        const question = trimmed.substring(5).trim();
        if (question) {
          toast.info('AI is currently unavailable');
          setSending(false);
          return;
        }
      }

      // Upload pending files first
      let uploadedAttachments: ChatAttachment[] = [];
      if (pendingFiles.length > 0) {
        setUploading(true);
        try {
          const results = await Promise.all(
            pendingFiles.map((f) => uploadChatAttachment(channelId, f)),
          );
          uploadedAttachments = results.filter((r): r is NonNullable<typeof r> => r !== null);
        } catch (uploadErr) {
          console.error('[WeldChat] File upload failed:', uploadErr);
          setUploading(false);
          setSending(false);
          return;
        }
        setUploading(false);
      }

      const attachmentsPayload = uploadedAttachments.length > 0 ? uploadedAttachments : undefined;

      // HTTP-first: POST to API, server persists + publishes via @weldsuite/realtime
      if (replyTo) {
        const body = replyMention ? `<@${replyTo.authorId}> ${trimmed}` : trimmed;
        await appApi.chatMessages.create({
          channelId,
          body,
          parentId: replyTo.messageId,
          attachments: attachmentsPayload,
        });
      } else {
        await appApi.chatMessages.create({ channelId, body: trimmed, attachments: attachmentsPayload });
      }
      setInput('');
      setMentions([]);
      setReplyTo(null);
      setPendingFiles([]);
      clearDraft();
      onSend();
      loadMessages();
      // Scroll to bottom (index 0 on inverted list) after the state update settles
      setTimeout(() => flatListRef.current?.scrollToOffset({ offset: 0, animated: true }), 100);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }, [editingMessage, handleEditSubmit, input, channelId, sending, uploading, onSend, userId, membersMap, mentions, replyTo, replyMention, pendingFiles, clearDraft]);

  const handleReaction = useCallback(async (emoji: string) => {
    if (!selectedMessage) return;
    const hasReacted = selectedMessage.reactions?.[emoji]?.includes(userId ?? '') ?? false;
    try {
      if (hasReacted) {
        await appApi.chatMessages.removeReaction(selectedMessage.id, emoji);
      } else {
        await appApi.chatMessages.addReaction(selectedMessage.id, { emoji });
      }
      loadMessages();
    } catch (err) {
      console.error(err);
    }
  }, [selectedMessage, channelId, userId]);

  const handleEmojiSelect = useCallback((emoji: string) => {
    if (selectedMessage) {
      handleReaction(emoji);
    } else {
      setInput((prev) => prev + emoji);
    }
  }, [selectedMessage, handleReaction]);

  const handleToggleReaction = useCallback(async (messageId: string, emoji: string, hasReacted: boolean) => {
    try {
      if (hasReacted) {
        await appApi.chatMessages.removeReaction(messageId, emoji);
      } else {
        await appApi.chatMessages.addReaction(messageId, { emoji });
      }
      loadMessages();
    } catch (err) {
      console.error(err);
    }
  }, [channelId]);

  // Order for the inverted FlatList: newest first (index 0 renders at the visual
  // bottom). Sort explicitly by createdAt rather than trusting the API/array
  // order — otherwise a newly sent message can land at the top of the chat.
  const reversedMessages = useMemo(
    () =>
      [...messages].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [messages],
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
      if (pinnedMessages.length >= 3) return;
      setMessageToPin(msg);
      setShowPinDuration(true);
    }
  }, [selectedMessage, channelId, pinnedMessages.length]);

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
            content: `${msg.authorName} pinned a message`,
            createdAt: new Date().toISOString(),
            type: 'system',
          });
        }
        return updated;
      });
      let expiresAt: string | undefined;
      if (duration && duration !== 'forever') {
        const ms = duration === '24h' ? 24 * 60 * 60 * 1000
          : duration === '7d' ? 7 * 24 * 60 * 60 * 1000
          : duration === '30d' ? 30 * 24 * 60 * 60 * 1000
          : 0;
        if (ms > 0) expiresAt = new Date(Date.now() + ms).toISOString();
      }
      await appApi.chatMessages.pin(msg.id, { expiresAt, silent });
      loadMessages();
    } catch (err) {
      console.error(err);
      setLocalPinnedIds((prev) => { const next = new Set(prev); next.delete(msg.id); return next; });
      loadMessages();
    }
  }, [messageToPin, channelId, pinDuration]);

  const handleSaveMessage = useCallback(async () => {
    const msg = selectedMessage;
    if (!msg || !userId) return;
    try {
      await appApiClient.post('/chat-bookmarks', {
        messageId: msg.id,
        channelId,
        userId,
      });
      toast.success('Message saved to Later');
    } catch {
      // Duplicate (already saved) — treat as success
      toast.success('Already saved');
    }
  }, [selectedMessage, channelId, userId, toast]);

  const handleDeleteMessage = useCallback(() => {
    const msg = selectedMessage;
    if (!msg) return;
    Alert.alert(
      'Delete Message',
      'Are you sure you want to delete this message? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // Optimistic remove
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
            try {
              await appApi.chatMessages.delete(msg.id);
              loadMessages();
            } catch (err) {
              console.error('[WeldChat] Delete failed:', err);
              loadMessages();
            }
          },
        },
      ],
    );
  }, [selectedMessage]);

  const openThread = useCallback((message: Message) => {
    router.push({ pathname: '/thread/[messageId]', params: { messageId: message.id, channelId } } as any);
  }, [channelId]);

  const formatDateLabel = useCallback((dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (msgDay.getTime() === today.getTime()) return 'Today';
    if (msgDay.getTime() === yesterday.getTime()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }, []);

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    if (item.type === 'system') {
      const call = classifyCallSystemMessage(item.content);
      if (call) {
        // Missed calls stay red; past/answered calls get a neutral gray theme.
        const isMissed = call.kind === 'missed';
        const bg = isMissed ? colors.danger : colors.bgTertiary;
        const fg = isMissed ? '#fff' : colors.textSecondary;
        const PhoneIcon = isMissed ? PhoneMissed : Phone;
        return (
          <View style={styles.systemMessage}>
            <View style={[styles.callSystemPill, { backgroundColor: bg }]}>
              {call.isVideo && !isMissed ? (
                <VideoCameraIcon size={14} color={fg} fill={fg} strokeWidth={2} />
              ) : (
                <PhoneIcon size={13} color={fg} fill={fg} strokeWidth={2} />
              )}
              <Text style={[styles.callSystemText, { color: fg }]}>{item.content}</Text>
            </View>
          </View>
        );
      }
      return (
        <View style={styles.systemMessage}>
          <Text style={styles.systemText}>{item.content}</Text>
        </View>
      );
    }

    // With inverted FlatList, data is reversed: index+1 is the chronologically previous message
    const prev = reversedMessages[index + 1];

    // Show date separator if first message of the day (chronologically)
    const itemDate = new Date(item.createdAt);
    const prevDate = prev ? new Date(prev.createdAt) : null;
    const showDateLabel = !prevDate ||
      itemDate.getDate() !== prevDate.getDate() ||
      itemDate.getMonth() !== prevDate.getMonth() ||
      itemDate.getFullYear() !== prevDate.getFullYear();
    const itemTime = new Date(item.createdAt).getTime();
    const prevTime = prev ? new Date(prev.createdAt).getTime() : 0;
    const timeDiff = itemTime - prevTime;
    const isCompact =
      !!prev &&
      prev.type !== 'system' &&
      prev.authorId === item.authorId &&
      !item.parentId &&
      !isNaN(timeDiff) &&
      timeDiff >= 0 &&
      timeDiff < 300000;

    const onLongPress = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setSelectedMessage(item);
      setShowActions(true);
    };

    const onSwipeReply = () => {
      setReplyTo({
        messageId: item.id,
        authorId: item.authorId,
        authorName: item.authorName,
        content: item.content,
      });
      setReplyMention(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    };

    const reactions = item.reactions && Object.keys(item.reactions).length > 0;
    const hasThread = (item.threadReplyCount ?? 0) > 0;

    const dateSeparator = showDateLabel ? (
      <View style={styles.dateSeparator}>
        <View style={styles.dateLine} />
        <Text style={styles.dateLabel}>{formatDateLabel(item.createdAt)}</Text>
        <View style={styles.dateLine} />
      </View>
    ) : null;

    const renderAttachments = (atts: ChatAttachment[]) => (
      <View style={styles.attachmentList}>
        {atts.map((att) => {
          if (att.mimeType.startsWith('image/')) {
            return (
              <TouchableOpacity
                key={att.id}
                activeOpacity={1}
                onPress={(e) => {
                  // Grow the photo FROM its thumbnail spot into the centered
                  // fullscreen viewer (shared-element). Measure the thumbnail's
                  // window rect so the viewer can interpolate from it to center.
                  const target = e.currentTarget as any;
                  if (target?.measureInWindow) {
                    target.measureInWindow((x: number, y: number, w: number, h: number) => {
                      setViewingImageOrigin({ x, y, width: w, height: h });
                      setViewingImage(att.url);
                    });
                  } else {
                    setViewingImageOrigin(null);
                    setViewingImage(att.url);
                  }
                }}
              >
                <Image source={{ uri: att.url }} style={styles.attachmentImage} resizeMode="cover" />
              </TouchableOpacity>
            );
          }
          if (att.mimeType.startsWith('audio/')) {
            return <AudioPlayer key={att.id} uri={att.url} />;
          }
          return (
            <TouchableOpacity key={att.id} style={styles.attachmentFile} onPress={() => openExternalUrl(att.url)}>
              <FileText size={20} color={colors.textMuted} />
              <View style={styles.attachmentFileInfo}>
                <Text style={styles.attachmentFileName} numberOfLines={1}>{att.fileName}</Text>
                <Text style={styles.attachmentFileSize}>{formatFileSize(att.fileSize)}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    );

    if (isCompact) {
      return (
        <>
          <SwipeableMessage onLongPress={onLongPress} onSwipeReply={onSwipeReply}>
            <View style={styles.messageCompact}>
              {item.content ? renderMessageText(item.content, membersMap, colors) : null}
              {item.editedAt ? <Text style={styles.editedLabel}>(edited)</Text> : null}
              {item.attachments && item.attachments.length > 0 && renderAttachments(item.attachments)}
              {reactions && (
                <ReactionBar
                  reactions={item.reactions!}
                  currentUserId={userId ?? ''}
                  onToggle={(emoji, hasReacted) => handleToggleReaction(item.id, emoji, hasReacted)}
                />
              )}
            </View>
          </SwipeableMessage>
          {dateSeparator}
        </>
      );
    }

    return (
      <>
        <SwipeableMessage onLongPress={onLongPress} onSwipeReply={onSwipeReply}>
          <View style={styles.message}>
            {item.authorAvatar ? (
              <Image source={{ uri: item.authorAvatar }} style={styles.msgAvatarImg} />
            ) : (
              <View style={styles.msgAvatar}>
                <Text style={styles.msgAvatarText}>
                  {(item.authorName || '?')[0].toUpperCase()}
                </Text>
              </View>
            )}
            <View style={styles.msgContent}>
              <View style={styles.msgHeader}>
                <Text style={styles.msgAuthor}>{item.authorName}</Text>
                <Text style={styles.msgTime}>
                  {new Date(item.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              {item.content ? renderMessageText(item.content, membersMap, colors) : null}
              {item.editedAt ? <Text style={styles.editedLabel}>(edited)</Text> : null}
              {item.attachments && item.attachments.length > 0 && renderAttachments(item.attachments)}
              {reactions && (
                <ReactionBar
                  reactions={item.reactions!}
                  currentUserId={userId ?? ''}
                  onToggle={(emoji, hasReacted) => handleToggleReaction(item.id, emoji, hasReacted)}
                />
              )}
              {hasThread && (
                <TouchableOpacity style={styles.threadLink} onPress={() => openThread(item)}>
                  <MessageSquare size={14} color={colors.textLink} />
                  <Text style={styles.threadText}>
                    {item.threadReplyCount} {item.threadReplyCount === 1 ? 'reply' : 'replies'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </SwipeableMessage>
        {dateSeparator}
      </>
    );
  };

  const channelName = channel?.name || '';
  const isPrivate = channel?.type === 'private';
  const isDm = channel?.type === 'dm';
  const isArchived = channel?.isArchived === true;
  // A call is already in progress (possibly minimized) → block starting another.
  const inCall = !!session;

  const handleStartCall = useCallback(
    async (callType: 'voice' | 'video') => {
      try {
        // If a call is already running in this channel, join it instead of
        // starting a new one. (The backend's start-and-join is idempotent too,
        // so this is also race-safe.)
        // For a DM, hand the peer's name/avatar to the call so the WhatsApp-style
        // call screen can show them — on both the start and join-active paths.
        const peer = isDm ? { name: channelName, avatar: channel?.picture, isDirect: true } : undefined;
        if (activeCall) {
          await joinCall(activeCall.callId, peer);
        } else {
          await startCall(channelId, callType, peer);
        }
      } catch {
        Alert.alert('Call failed', 'Could not connect to the call. Please try again.');
      }
    },
    [activeCall, joinCall, startCall, channelId, isDm, channelName, channel?.picture],
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
  const currentPinned = pinnedMessages.length > 0 ? pinnedMessages[pinnedIndex % pinnedMessages.length] : null;

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

  return (
    <View style={styles.container}>
      {/* Header */}
      {!hideHeader && (
      <View style={styles.header}>
        <View style={styles.headerContent}>
        {!hideBackButton && (
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <ChevronLeft size={26} color={colors.textPrimary} strokeWidth={2.2} />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.headerIdentity}
          activeOpacity={0.7}
          onPress={() => {
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
          }}
          disabled={!isDm}
        >
          {isDm ? (
            channel?.picture ? (
              <Image source={{ uri: channel.picture }} style={styles.headerAvatar} />
            ) : (
              <View style={styles.headerAvatarFallback}>
                <Text style={styles.headerAvatarText}>
                  {(channelName || '?')[0].toUpperCase()}
                </Text>
              </View>
            )
          ) : (
            <View style={styles.headerChannelIcon}>
              {isPrivate ? (
                <Lock size={21} color={colors.textPrimary} strokeWidth={2.25} />
              ) : (
                <Hash size={21} color={colors.textPrimary} strokeWidth={2.25} />
              )}
            </View>
          )}
          <View style={styles.headerIdentityText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {channelName}
            </Text>
            {isDm && peerIsOnline !== null && (
              <Text style={styles.headerPresenceText} numberOfLines={1}>
                {peerIsOnline ? 'Active now' : 'Offline'}
              </Text>
            )}
          </View>
        </TouchableOpacity>

        <View style={styles.headerActions}>
          {/* While a call is already active (e.g. minimized to the top bar),
              disable the call buttons so tapping them can't start a second call. */}
          <TouchableOpacity
            style={[styles.headerAction, inCall && styles.headerActionDisabled]}
            activeOpacity={0.6}
            disabled={inCall}
            onPress={() => handleStartCall('video')}
          >
            <VideoCameraIcon size={30} color={colors.textPrimary} strokeWidth={1.6} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.headerAction, inCall && styles.headerActionDisabled]}
            activeOpacity={0.6}
            disabled={inCall}
            onPress={() => handleStartCall('voice')}
          >
            <Phone size={22} color={colors.textPrimary} strokeWidth={2} />
          </TouchableOpacity>
        </View>
        </View>
      </View>
      )}

      {/* Active-call banner — tap to join the ongoing call */}
      {activeCall && session?.callId !== activeCall.callId && (
        <TouchableOpacity
          style={styles.callBanner}
          activeOpacity={0.85}
          onPress={() => handleStartCall(activeCall.callType)}
        >
          <View style={styles.callBannerLeft}>
            <View style={styles.callBannerDot} />
            {activeCall.callType === 'video' ? (
              <VideoCameraIcon size={18} color={colors.success} strokeWidth={2} />
            ) : (
              <Phone size={18} color={colors.success} strokeWidth={2} />
            )}
            <Text style={styles.callBannerText} numberOfLines={1}>
              {activeCall.callType === 'video' ? 'Video call in progress' : 'Voice call in progress'}
            </Text>
          </View>
          <View style={styles.callBannerJoinBtn}>
            <Text style={styles.callBannerJoinText}>Join</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Pinned message bar */}
      {currentPinned && (
        <TouchableOpacity
          style={styles.pinnedBar}
          onPress={() => {
            if (pinnedMessages.length > 1) {
              setPinnedIndex((i) => i + 1);
            }
            const idx = reversedMessages.findIndex((m) => m.id === currentPinned.id);
            if (idx >= 0) {
              flatListRef.current?.scrollToIndex({ index: idx, animated: true });
            }
          }}
          activeOpacity={0.7}
        >
          <View style={styles.pinnedLineContainer}>
            {pinnedMessages.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.pinnedLineSegment,
                  { backgroundColor: i === (pinnedIndex % pinnedMessages.length) ? colors.brand : colors.bgTertiary },
                ]}
              />
            ))}
          </View>
          <View style={styles.pinnedContent}>
            <Text style={styles.pinnedAuthor} numberOfLines={1}>
              {currentPinned.authorName}
              {pinnedMessages.length > 1 && (
                <Text style={styles.pinnedCount}>{`  ${(pinnedIndex % pinnedMessages.length) + 1} of ${pinnedMessages.length}`}</Text>
              )}
            </Text>
            <Text style={styles.pinnedText} numberOfLines={1}>
              {currentPinned.content}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => {
              const msg = currentPinned;
              if (!msg) return;
              setLocalPinnedIds((prev) => { const next = new Set(prev); next.delete(msg.id); return next; });
              setMessages((prev) => prev.map((m) => m.id === msg.id ? { ...m, isPinned: false } : m));
              appApi.chatMessages.unpin(msg.id).then(() => loadMessages()).catch(console.error);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </TouchableOpacity>
      )}

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
          initialNumToRender={20}
          maxToRenderPerBatch={10}
          windowSize={10}
          removeClippedSubviews
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {isDm ? `Conversation with ${channelName}` : `Welcome to #${channelName}`}
              </Text>
              <Text style={styles.emptyText}>
                This is the start of the conversation.
              </Text>
            </View>
          }
        />
      </Animated.View>

      {/* Mention picker */}
      <MentionPicker
        query={mentionQuery ?? ''}
        visible={mentionQuery !== null}
        onSelect={(member) => {
          const atIndex = input.lastIndexOf('@');
          const before = input.substring(0, atIndex);
          setInput(`${before}<@${member.userId}> `);
          setMentions((prev) => [...prev, member.userId]);
          setMentionQuery(null);
        }}
      />

      <KeyboardStickyView
        style={styles.bottomStack}
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
          accessibilityLabel="Scroll to latest messages"
        >
          <BlurView
            intensity={100}
            tint={mode === 'dark' ? 'dark' : 'light'}
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <ChevronDown size={21} color={colors.textPrimary} strokeWidth={2.5} />
        </TouchableOpacity>
      )}
      {/* Edit mode banner */}
      {editingMessage && (
        <View style={styles.editBar}>
          <Pencil size={14} color={colors.brand} strokeWidth={2.5} />
          <Text style={styles.editBarLabel} numberOfLines={1}>
            Editing message
          </Text>
          <TouchableOpacity
            style={styles.editBarClose}
            onPress={() => {
              setEditingMessage(null);
              setInput('');
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={14} color={colors.textPrimary} strokeWidth={3} />
          </TouchableOpacity>
        </View>
      )}

      {/* Reply preview */}
      {replyTo && (
        <View style={styles.replyBar}>
          <View style={styles.replyBarRow}>
            <TouchableOpacity
              style={styles.replyBarClose}
              onPress={() => setReplyTo(null)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <X size={14} color={colors.textPrimary} strokeWidth={3} />
            </TouchableOpacity>
            <Text style={styles.replyBarLabel} numberOfLines={1}>
              Replying to <Text style={styles.replyBarLabelName}>{replyTo.authorName}</Text>
            </Text>
            <TouchableOpacity
              style={styles.replyBarMention}
              onPress={() => setReplyMention((v) => !v)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.6}
            >
              <AtSign size={16} color={replyMention ? colors.brand : colors.textMuted} strokeWidth={2.5} />
              <Text style={[styles.replyBarMentionText, { color: replyMention ? colors.brand : colors.textMuted }]}>
                {replyMention ? 'ON' : 'OFF'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Pending files */}
      {pendingFiles.length > 0 && (
        <View style={styles.pendingFiles}>
          {pendingFiles.map((f, i) => (
            <View key={i} style={styles.pendingFile}>
              <Paperclip size={12} color={colors.textMuted} />
              <Text style={styles.pendingFileName} numberOfLines={1}>{f.name}</Text>
              <TouchableOpacity onPress={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}>
                <X size={14} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* Typing indicator */}
      {typingUsers.length > 0 && (
        <View style={styles.typingRow}>
          <Text style={styles.typingText}>
            {typingUsers.length === 1
              ? `${membersMap.get(typingUsers[0]) ?? 'Someone'} is typing...`
              : typingUsers.length === 2
              ? `${membersMap.get(typingUsers[0]) ?? 'Someone'} and ${membersMap.get(typingUsers[1]) ?? 'someone'} are typing...`
              : `${membersMap.get(typingUsers[0]) ?? 'Someone'} and ${typingUsers.length - 1} others are typing...`}
          </Text>
        </View>
      )}

      {/* Divider line — sits directly above the input; any reply/edit/file/
          typing context rows render above this line, connecting to it flush. */}
      <View
        style={[
          styles.composerDivider,
          (!!editingMessage || !!replyTo || pendingFiles.length > 0 || typingUsers.length > 0) &&
            styles.composerDividerConnected,
        ]}
      />

      {/* Archived banner or input bar */}
      {isArchived ? (
        <View style={styles.archivedBanner}>
          <Archive size={16} color={colors.textMuted} />
          <Text style={styles.archivedText}>This conversation is archived</Text>
          <TouchableOpacity style={styles.unarchiveBtn} onPress={handleUnarchive}>
            <Text style={styles.unarchiveBtnText}>Unarchive</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {/* Input bar */}
      <View style={[styles.inputBar, !isInputExpanded && styles.inputBarCollapsed, isArchived && styles.inputBarHidden]}>

        {isRecording ? (
          <View style={styles.recordingPill}>
            <TouchableOpacity
              style={styles.stopBtnInline}
              onPress={handleCancelRecording}
              activeOpacity={0.8}
            >
              <View style={styles.stopSquare} />
            </TouchableOpacity>
            <Waveform active={isRecording} color={colors.textSecondary} level={meteringDb} />
            <TouchableOpacity
              style={styles.sendBtn}
              onPress={handleSendRecording}
              activeOpacity={0.85}
            >
              <ArrowUp size={17} color={colors.bgPrimary} strokeWidth={2.5} />
            </TouchableOpacity>
          </View>
        ) : isInputExpanded ? (
          <View style={styles.composerShadow}>
          <View style={styles.inputContainer}>
            <BlurView
              intensity={100}
              tint={mode === 'dark' ? 'dark' : 'light'}
              experimentalBlurMethod="dimezisBlurView"
              style={styles.composerGlass}
              pointerEvents="none"
            />
            {/* Text input area */}
            <ScrollView
              ref={inputScrollRef}
              style={styles.inputWrapper}
              contentContainerStyle={styles.inputWrapperContent}
              keyboardShouldPersistTaps="always"
              showsVerticalScrollIndicator
              nestedScrollEnabled
              overScrollMode="never"
              decelerationRate="normal"
              onScrollBeginDrag={() => { inputUserScrollingRef.current = true; }}
              onScrollEndDrag={(e) => {
                const v = e.nativeEvent.velocity?.y ?? 0;
                if (Math.abs(v) < 0.05) {
                  inputUserScrollingRef.current = false;
                }
              }}
              onMomentumScrollEnd={() => { inputUserScrollingRef.current = false; }}
              onContentSizeChange={(_, h) => {
                const grew = h > inputContentHeightRef.current;
                inputContentHeightRef.current = h;
                if (grew && !inputUserScrollingRef.current) {
                  inputScrollRef.current?.scrollToEnd({ animated: false });
                }
              }}
            >
              <TextInput
                ref={inputRef}
                style={[styles.input, hasMentionTokens(input) && styles.inputTransparent]}
                value={input}
                onChangeText={(text) => {
                  setInput(text);
                  if (text.length > 0) onKeystroke();
                  // Draft autosave (skip in edit mode — we're editing an existing message)
                  if (!editingMessage) {
                    if (text.trim().length > 0) {
                      saveDraft(text);
                    } else {
                      // Input cleared — delete the draft
                      clearDraft();
                    }
                  }
                  const atIndex = text.lastIndexOf('@');
                  if (atIndex >= 0 && (atIndex === 0 || text[atIndex - 1] === ' ')) {
                    const query = text.substring(atIndex + 1);
                    if (!query.includes(' ')) {
                      setMentionQuery(query);
                    } else {
                      setMentionQuery(null);
                    }
                  } else {
                    setMentionQuery(null);
                  }
                }}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => setIsInputFocused(false)}
                placeholder={isDm ? `Message...` : `Message #${channelName}`}
                placeholderTextColor={colors.textSecondary}
                multiline
                autoFocus
                scrollEnabled={false}
                textAlignVertical="top"
              />
              {hasMentionTokens(input) && (
                <View style={styles.inputOverlay} pointerEvents="none">
                  {renderInputWithBadges(input, membersMap, colors)}
                </View>
              )}
            </ScrollView>

            {/* Bottom action bar — ChatGPT-style: "+" on the left, mic + a solid
                circular voice/send button on the right. */}
            <View style={styles.inputActions}>
              <TouchableOpacity
                style={styles.composerPlusBtn}
                onPress={openAttachmentPicker}
                activeOpacity={0.6}
              >
                <Plus size={24} color={colors.textPrimary} strokeWidth={2.1} />
              </TouchableOpacity>
              <View style={styles.composerActionsRight}>
                <TouchableOpacity
                  style={[styles.composerSolidBtn, (sending || uploading) && styles.sendBtnDisabled]}
                  onPress={(input.trim() || pendingFiles.length > 0) ? handleSend : handleStartRecording}
                  disabled={sending || uploading}
                  activeOpacity={0.85}
                >
                  {uploading ? (
                    <ActivityIndicator size="small" color={colors.bgPrimary} />
                  ) : (input.trim() || pendingFiles.length > 0) ? (
                    <ArrowUp size={20} color={colors.bgPrimary} strokeWidth={2.6} />
                  ) : (
                    <AudioLines size={19} color={colors.bgPrimary} strokeWidth={2} />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
          </View>
        ) : (
          <View style={styles.composerShadowCollapsed}>
          <View style={styles.inputContainerCollapsed}>
            <BlurView
              intensity={100}
              tint={mode === 'dark' ? 'dark' : 'light'}
              experimentalBlurMethod="dimezisBlurView"
              style={styles.composerGlass}
              pointerEvents="none"
            />
            <TouchableOpacity style={styles.plainBtn} onPress={openAttachmentPicker}>
              <Plus size={24} color={colors.textPrimary} strokeWidth={2.1} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.collapsedInputArea}
              onPress={() => setIsInputFocused(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.collapsedPlaceholder} numberOfLines={1}>
                {isDm ? `Message...` : `Message #${channelName}`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.composerSolidBtn}
              onPress={handleStartRecording}
              activeOpacity={0.85}
            >
              <AudioLines size={19} color={colors.bgPrimary} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          </View>
        )}
      </View>
      </KeyboardStickyView>

      {/* Message actions bottom sheet */}
      <MessageActions
        visible={showActions}
        message={selectedMessage}
        onClose={() => { setShowActions(false); setSelectedMessage(null); }}
        onReply={() => {
          if (selectedMessage) {
            setReplyTo({
              messageId: selectedMessage.id,
              authorId: selectedMessage.authorId,
              authorName: selectedMessage.authorName,
              content: selectedMessage.content,
            });
            setReplyMention(true);
          }
        }}
        onReact={() => setShowEmojiPicker(true)}
        onThread={() => selectedMessage && openThread(selectedMessage)}
        onPin={handlePin}
        onCopy={() => {
          if (selectedMessage) Clipboard.setString(selectedMessage.content);
        }}
        onQuickReact={handleReaction}
        onSave={handleSaveMessage}
        onEdit={() => {
          if (selectedMessage) {
            setEditingMessage(selectedMessage);
            setInput(selectedMessage.content);
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        onDelete={handleDeleteMessage}
        isOwnMessage={selectedMessage?.authorId === userId}
      />

      {/* Emoji picker */}
      <EmojiPicker
        visible={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
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
      <Modal
        visible={showPinDuration}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPinDuration(false)}
      >
        <Pressable style={styles.pinDurationBackdrop} onPress={() => { setShowPinDuration(false); setPinDuration(null); setMessageToPin(null); }}>
          <Pressable style={styles.pinDurationSheet}>
            <View style={styles.pinDurationHandle}>
              <View style={styles.pinDurationHandleBar} />
            </View>
            {!pinDuration ? (
              <>
                <Text style={styles.pinDurationTitle}>Pin for how long?</Text>
                {[
                  { label: '24 hours', value: '24h', icon: <Clock size={20} color={colors.textPrimary} /> },
                  { label: '7 days', value: '7d', icon: <Clock size={20} color={colors.textPrimary} /> },
                  { label: '30 days', value: '30d', icon: <Clock size={20} color={colors.textPrimary} /> },
                  { label: 'Always', value: 'forever', icon: <InfinityIcon size={20} color={colors.textPrimary} /> },
                ].map((opt) => (
                  <Pressable
                    key={opt.value}
                    style={({ pressed }) => [styles.pinDurationOption, pressed && styles.pinDurationOptionPressed]}
                    onPress={() => handleSelectDuration(opt.value)}
                  >
                    {opt.icon}
                    <Text style={styles.pinDurationOptionText}>{opt.label}</Text>
                  </Pressable>
                ))}
              </>
            ) : (
              <>
                <Text style={styles.pinDurationTitle}>Notify others?</Text>
                <Pressable
                  style={({ pressed }) => [styles.pinDurationOption, pressed && styles.pinDurationOptionPressed]}
                  onPress={() => handlePinConfirm(false)}
                >
                  <Bell size={20} color={colors.textPrimary} />
                  <View style={styles.pinOptionContent}>
                    <Text style={styles.pinDurationOptionText}>Pin with alert</Text>
                    <Text style={styles.pinOptionDesc}>Members will be notified</Text>
                  </View>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.pinDurationOption, pressed && styles.pinDurationOptionPressed]}
                  onPress={() => handlePinConfirm(true)}
                >
                  <BellOff size={20} color={colors.textMuted} />
                  <View style={styles.pinOptionContent}>
                    <Text style={styles.pinDurationOptionText}>Pin silently</Text>
                    <Text style={styles.pinOptionDesc}>No one will be notified</Text>
                  </View>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ColorScheme, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    header: {
      paddingTop: topInset,
      backgroundColor: c.bgPrimary,
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
      paddingLeft: 16,
      paddingRight: 8,
    },
    backBtn: {
      width: 28,
      height: 40,
      justifyContent: 'flex-start',
      alignItems: 'center',
      flexDirection: 'row',
    },
    headerIdentity: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingLeft: 10,
      paddingRight: 4,
    },
    headerIdentityText: {
      flex: 1,
      justifyContent: 'center',
    },
    headerTitle: { fontSize: 16, fontWeight: '600', color: c.textPrimary, lineHeight: 22 },
    headerPresenceText: { fontSize: 12, color: c.textSecondary, lineHeight: 15, marginTop: -1 },
    headerAvatar: { width: 33, height: 33, borderRadius: 12.5 },
    headerAvatarFallback: {
      width: 33,
      height: 33,
      borderRadius: 12.5,
      backgroundColor: c.brand,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerAvatarText: { fontSize: 13, fontWeight: '700', color: '#fff' },
    headerChannelIcon: {
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 2,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    headerAction: {
      width: 36,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerActionDisabled: { opacity: 0.35 },
    pinnedBar: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: 16, paddingVertical: 10,
      backgroundColor: c.bgPrimary,
      borderBottomWidth: 1, borderBottomColor: c.bgTertiary,
    },
    callBanner: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      paddingHorizontal: 16, paddingVertical: 10,
      backgroundColor: c.success + '1A',
      borderBottomWidth: 1, borderBottomColor: c.success + '33',
    },
    callBannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
    callBannerDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.success },
    callBannerText: { fontSize: 14, fontWeight: '600', color: c.textPrimary, flexShrink: 1 },
    callBannerJoinBtn: {
      backgroundColor: c.success, borderRadius: 16,
      paddingHorizontal: 16, paddingVertical: 6,
    },
    callBannerJoinText: { color: '#fff', fontSize: 13, fontWeight: '700' },
    pinnedLineContainer: { width: 3, alignSelf: 'stretch', borderRadius: 2, gap: 2, overflow: 'hidden' },
    pinnedLineSegment: { flex: 1, borderRadius: 2 },
    pinnedContent: { flex: 1 },
    pinnedAuthor: { fontSize: 12, fontWeight: '700', color: c.brand },
    pinnedCount: { fontSize: 11, fontWeight: '500', color: c.textMuted },
    pinnedText: { fontSize: 13, color: c.textSecondary, marginTop: 1 },
    listContainer: { flex: 1 },
    list: {
      paddingHorizontal: 16,
      // No paddingTop here: the visual bottom padding of the inverted list is
      // produced by the *animated* marginBottom on the Animated.View wrapper, so it
      // can interpolate smoothly when the composer grows / shrinks.
      paddingBottom: 8,
      flexGrow: 1,
      justifyContent: 'flex-end',
    },
    // Top-only margins so spacing doesn't double-count (prev row's bottom margin
    // + this row's top margin). New-group messages get a clear gap; consecutive
    // same-author (compact) messages sit tightly under the first one.
    message: { flexDirection: 'row', marginTop: 12, marginBottom: 0 },
    messageCompact: { paddingLeft: 42, marginTop: 3, marginBottom: 0 },
    messagePressed: { backgroundColor: c.bgSecondary, marginHorizontal: -16, paddingHorizontal: 16 },
    dateSeparator: {
      flexDirection: 'row', alignItems: 'center', marginVertical: 16, gap: 12,
    },
    dateLine: { flex: 1, height: 1, backgroundColor: c.border + '99' },
    dateLabel: { fontSize: 12, fontWeight: '600', color: c.textMuted },
    systemMessage: {
      alignItems: 'center', marginVertical: 12,
    },
    systemText: {
      fontSize: 13, color: c.textSecondary, fontWeight: '500',
      backgroundColor: c.bgTertiary,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
      paddingHorizontal: 12, paddingVertical: 6,
      borderRadius: 9, overflow: 'hidden',
    },
    // Call events (made = green, missed = red) — tint applied inline.
    callSystemPill: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9,
    },

    callSystemText: { fontSize: 13, fontWeight: '600' },
    // Floating circular "jump to newest" button, pinned just above the composer.
    scrollToBottomBtn: {
      position: 'absolute',
      bottom: '100%',
      alignSelf: 'center',
      marginBottom: 10,
      width: 38,
      height: 38,
      borderRadius: 19,
      // Frosted glass: only a faint tint so the clipped BlurView material below
      // stays visible (a high-alpha fill would hide the blur and look solid).
      backgroundColor: c.bgPrimary + '1f',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      overflow: 'hidden',
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
      backgroundColor: c.brand, justifyContent: 'center', alignItems: 'center', marginRight: 10, marginTop: 1,
    },
    msgAvatarText: { fontSize: 15, fontWeight: '700', color: '#fff' },
    msgContent: { flex: 1 },
    msgHeader: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 1 },
    msgAuthor: { fontSize: 14.5, fontWeight: '600', color: c.textPrimary, marginRight: 8 },
    msgTime: { fontSize: 12, color: c.textMuted },
    threadLink: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, minHeight: 32, paddingVertical: 2 },
    threadText: { fontSize: 13, color: c.textLink, fontWeight: '500' },
    empty: { padding: 16 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginBottom: 4 },
    emptyText: { fontSize: 14, color: c.textMuted },
    archivedBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 16, paddingVertical: 12,
      backgroundColor: c.bgSecondary,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.bgTertiary,
    },
    archivedText: { flex: 1, fontSize: 14, color: c.textMuted },
    unarchiveBtn: {
      paddingHorizontal: 12, paddingVertical: 6,
      backgroundColor: c.brand, borderRadius: 8,
    },
    unarchiveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
    inputBar: {
      paddingHorizontal: 12, paddingTop: 0, paddingBottom: 8 + bottomInset,
    },
    inputBarCollapsed: {
      paddingHorizontal: 20,
      paddingBottom: bottomInset,
    },
    inputBarHidden: { display: 'none' },
    bottomStack: {
      position: 'absolute',
      bottom: 0, left: 0, right: 0,
      // Solid white composer area. The divider line is a separate element
      // (composerDivider) so reply/edit context rows can sit above it.
      backgroundColor: '#ffffff',
    },
    // Horizontal line directly above the input field. Reply/edit/file/typing
    // context rows render above this line; the input field below it.
    composerDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginTop: 10,
      marginBottom: 10,
    },
    // When a context row (reply/edit/files/typing) sits above the line, drop the
    // top gap so the row connects flush to the line.
    composerDividerConnected: {
      marginTop: 0,
    },
    inputContainer: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: 26,
      // Frosted-glass input field: translucent fill + a BlurView material behind
      // the content (clipped to the rounded corners). Reads as glass on iOS;
      // falls back to the translucent tint where blur is unavailable.
      // NOTE: shadow lives on the composerShadow wrapper — overflow:hidden here
      // (needed to clip the blur) would otherwise clip the shadow away.
      backgroundColor: `${c.bgPrimary}0d`,
      overflow: 'hidden',
      paddingHorizontal: 8,
      paddingTop: 6,
      paddingBottom: 8,
    },
    // Wraps the clipped glass pill. No drop-shadow — flat composer look.
    composerShadow: {
      borderRadius: 26,
    },
    inputContainerCollapsed: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 26,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: `${c.bgPrimary}0d`,
      overflow: 'hidden',
      paddingHorizontal: 8,
      paddingVertical: 5,
      gap: 4,
    },
    composerShadowCollapsed: {
      marginHorizontal: 12,
      borderRadius: 26,
    },
    composerGlass: {
      ...StyleSheet.absoluteFillObject,
    },
    collapsedInputArea: {
      flex: 1,
      paddingHorizontal: 4,
      minHeight: 30,
      justifyContent: 'center',
    },
    collapsedPlaceholder: {
      fontSize: 17, fontWeight: '500', color: c.textPrimary, opacity: 0.45,
    },
    plainBtn: {
      width: 35, height: 35,
      justifyContent: 'center', alignItems: 'center',
    },
    inputWrapper: { maxHeight: 140 },
    inputWrapperContent: { position: 'relative' },
    input: {
      fontSize: 16, lineHeight: 22, color: c.textPrimary,
      paddingTop: 4, paddingBottom: 4, paddingHorizontal: 8,
      minHeight: 33,
    },
    inputTransparent: { color: 'transparent' },
    inputOverlay: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      paddingTop: 7, paddingBottom: 8, paddingHorizontal: 8, justifyContent: 'center',
    },
    inputActions: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 2,
    },
    composerPlusBtn: {
      width: 36, height: 36, borderRadius: 18,
      justifyContent: 'center', alignItems: 'center',
    },
    composerActionsRight: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    composerSolidBtn: {
      width: 33, height: 33, borderRadius: 16.5,
      backgroundColor: c.textPrimary,
      justifyContent: 'center', alignItems: 'center',
    },
    sendBtn: {
      width: 33, height: 33, borderRadius: 16.5,
      backgroundColor: c.textPrimary,
      justifyContent: 'center', alignItems: 'center',
      marginRight: 2,
    },
    sendBtnDisabled: {
      opacity: 0.3,
    },
    recordingPill: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.bgTertiary,
      backgroundColor: c.bgPrimary,
      marginHorizontal: 12,
      paddingHorizontal: 7,
      paddingVertical: 6,
      gap: 6,
    },
    stopBtnInline: {
      width: 38, height: 38, borderRadius: 19,
      justifyContent: 'center', alignItems: 'center',
    },
    stopSquare: {
      width: 13, height: 13, borderRadius: 2.5,
      backgroundColor: c.textPrimary,
    },
    editBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: c.bgSecondary,
      gap: 8,
    },
    editBarLabel: {
      flex: 1,
      fontSize: 13,
      color: c.brand,
      fontWeight: '600',
    },
    editBarClose: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.bgTertiary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editedLabel: {
      fontSize: 12,
      color: c.textMuted,
      fontStyle: 'italic',
      marginTop: 2,
    },
    replyBar: {
      position: 'relative',
      backgroundColor: c.bgSecondary,
      // Solid line at the top of the reply row (doesn't fade out).
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    replyBarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 10,
      gap: 12,
    },
    replyBarClose: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.bgSecondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    replyBarLabel: {
      flex: 1,
      fontSize: 14,
      color: c.textMuted,
    },
    replyBarLabelName: {
      fontWeight: '700',
      color: c.textPrimary,
    },
    replyBarMention: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    replyBarMentionText: {
      fontSize: 14,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    pendingFiles: {
      flexDirection: 'row', flexWrap: 'wrap', gap: 6,
      paddingHorizontal: 12, paddingTop: 8, backgroundColor: c.bgPrimary,
    },
    pendingFile: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: c.bgAccent, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
    },
    pendingFileName: { fontSize: 12, color: c.textSecondary, maxWidth: 100 },
    attachmentList: { marginTop: 6, gap: 6 },
    attachmentImage: {
      width: '100%' as any, maxWidth: 280, aspectRatio: 4 / 3, borderRadius: 8, backgroundColor: c.bgSecondary,
    },
    attachmentFile: {
      flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8,
      backgroundColor: c.bgSecondary, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 10, maxWidth: 250,
    },
    attachmentFileInfo: { flex: 1 },
    attachmentFileName: { fontSize: 13, fontWeight: '600' as const, color: c.textPrimary },
    attachmentFileSize: { fontSize: 11, color: c.textMuted, marginTop: 1 },
    typingRow: {
      paddingHorizontal: 16, paddingVertical: 4, backgroundColor: c.bgPrimary,
    },
    typingText: { fontSize: 12, color: c.textMuted, fontStyle: 'italic' },
    pinDurationBackdrop: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end',
    },
    pinDurationSheet: {
      backgroundColor: c.bgPrimary,
      borderTopLeftRadius: 14, borderTopRightRadius: 14,
      paddingBottom: 8 + bottomInset,
    },
    pinDurationHandle: { alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
    pinDurationHandleBar: { width: 36, height: 5, borderRadius: 3, backgroundColor: c.bgAccent },
    pinDurationTitle: {
      fontSize: 15, fontWeight: '700', color: c.textPrimary,
      paddingHorizontal: 20, paddingBottom: 8,
    },
    pinDurationOption: {
      flexDirection: 'row', alignItems: 'center', gap: 14,
      paddingVertical: 14, paddingHorizontal: 20,
    },
    pinDurationOptionPressed: { backgroundColor: c.bgTertiary },
    pinDurationOptionText: { fontSize: 16, color: c.textPrimary },
    pinOptionContent: { flex: 1 },
    pinOptionDesc: { fontSize: 13, color: c.textMuted, marginTop: 1 },
  });
