/**
 * Conversation thread — reply / note / close, same actions as the platform pane.
 * Kept live by `useDeskConversationLive` (hub records + visitor typing/presence).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useObserve } from 'expo-observe';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Send, CheckCircle2, RotateCcw } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { formatShortTime } from '@weldsuite/mobile-ui/utils/dateFormatter';

import api from '@/services/api';
import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { ErrorState, LoadingState } from '@/components/data-states';
import { ChannelBadge, ConversationStateBadge } from '@/components/status-badge';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';
import { mergeDeskMessage, useDeskConversationLive } from '@/hooks/useDeskConversationLive';
import type { DeskConversation, DeskConversationWithMessages, DeskMessage } from '@/types/desk';

type ComposerMode = 'message' | 'note';

type Translations = ReturnType<typeof useI18n>['t'];
type ThemeColors = ReturnType<typeof useTheme>['colors'];

function resolveConversationTitle(data: DeskConversationWithMessages | null, fallback: string) {
  if (!data) return fallback;
  return data.name || data.email || `#${data.conversationNumber}`;
}

interface ConversationHeaderProps {
  data: DeskConversationWithMessages | null;
  title: string;
  visitorOnline: boolean;
  managing: boolean;
  onBack: () => void;
  onToggleState: () => void;
}

function ConversationHeader({ data, title, visitorOnline, managing, onBack, onToggleState }: Readonly<ConversationHeaderProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const isOpen = data?.state === 'open';

  return (
    <ScreenHeader
      title={title}
      subtitle={data?.email ?? undefined}
      onBack={onBack}
      actions={
        data ? (
          <>
            <IconButton
              icon={
                isOpen ? (
                  <CheckCircle2 size={20} color={colors.text} />
                ) : (
                  <RotateCcw size={20} color={colors.text} />
                )
              }
              accessibilityLabel={isOpen ? t.conversation.close : t.conversation.reopen}
              onPress={onToggleState}
              disabled={managing}
            />
          </>
        ) : null
      }
      below={
        data ? (
          <View style={styles.metaRow}>
            <ConversationStateBadge state={data.state} />
            <ChannelBadge channel={data.channel} />
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              #{data.conversationNumber}
            </Text>
            {visitorOnline ? (
              <View style={styles.online}>
                <View style={styles.onlineDot} />
                <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
                  {t.conversation.visitorOnline}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null
      }
    />
  );
}

interface ComposerProps {
  mode: ComposerMode;
  body: string;
  sending: boolean;
  onModeChange: (mode: ComposerMode) => void;
  onBodyChange: (text: string) => void;
  onTyping: () => void;
  onSend: () => void;
}

function Composer({ mode, body, sending, onModeChange, onBodyChange, onTyping, onSend }: Readonly<ComposerProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  const handleChangeText = (text: string) => {
    onBodyChange(text);
    if (mode === 'message' && text.trim()) onTyping();
  };

  return (
    <View style={[styles.composer, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
      <View style={styles.modeRow}>
        {(['message', 'note'] as const).map((m) => {
          const active = mode === m;
          return (
            <Pressable
              key={m}
              onPress={() => onModeChange(m)}
              style={[
                styles.modeChip,
                { backgroundColor: active ? colors.text : colors.secondary },
              ]}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '600',
                  color: active ? colors.background : colors.text,
                }}
              >
                {m === 'message' ? t.conversation.reply : t.conversation.note}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.inputRow, { backgroundColor: colors.secondary }]}>
        <TextInput
          value={body}
          onChangeText={handleChangeText}
          placeholder={
            mode === 'message'
              ? t.conversation.replyPlaceholder
              : t.conversation.notePlaceholder
          }
          placeholderTextColor={colors.mutedForeground}
          multiline
          style={[styles.input, { color: colors.text }]}
        />
        <Pressable
          onPress={onSend}
          disabled={!body.trim() || sending}
          style={[
            styles.send,
            {
              backgroundColor: body.trim() ? BRAND : colors.border,
              opacity: sending ? 0.6 : 1,
            },
          ]}
          accessibilityLabel={t.conversation.send}
        >
          {sending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Send size={18} color="#fff" />
          )}
        </Pressable>
      </View>
    </View>
  );
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { markInteractive } = useObserve();
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const toast = useToast();
  const listRef = useRef<FlatList<DeskMessage>>(null);

  const [data, setData] = useState<DeskConversationWithMessages | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<ComposerMode>('message');
  const [sending, setSending] = useState(false);
  const [managing, setManaging] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(false);
      const res = await api.getConversation(id, true);
      if (!res.success || !res.data) {
        setError(true);
        return;
      }
      setData(res.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const applyMessage = useCallback((message: DeskMessage) => {
    setData((prev) => (prev ? { ...prev, messages: mergeDeskMessage(prev.messages ?? [], message) } : prev));
  }, []);

  const applyConversation = useCallback((conversation: DeskConversation) => {
    setData((prev) => (prev ? { ...prev, ...conversation, messages: prev.messages } : prev));
  }, []);

  const live = useDeskConversationLive({
    conversationId: id,
    onMessage: applyMessage,
    onConversation: applyConversation,
    onResume: () => void load(),
  });

  const send = useCallback(async () => {
    if (!id || !body.trim() || sending) return;
    setSending(true);
    live.stopTyping();
    try {
      const res = await api.replyToConversation(id, { kind: mode, body: body.trim() });
      if (!res.success || !res.data) {
        // Keep the draft so the agent can retry.
        toast.error(t.conversation.sendError);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setBody('');
      applyConversation(res.data.conversation);
      applyMessage(res.data.message);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } finally {
      setSending(false);
    }
  }, [id, body, mode, sending, live, toast, t, applyConversation, applyMessage]);

  const toggleState = useCallback(async () => {
    if (!id || !data || managing) return;
    setManaging(true);
    try {
      const action = data.state === 'open' ? 'close' : 'open';
      const res = await api.manageConversation(id, { action });
      if (!res.success || !res.data) {
        toast.error(t.conversation.manageError);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      applyConversation(res.data.conversation);
      applyMessage(res.data.message);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } finally {
      setManaging(false);
    }
  }, [id, data, managing, toast, t, applyConversation, applyMessage]);

  const title = resolveConversationTitle(data, t.conversation.title);

  const header = (
    <ConversationHeader
      data={data}
      title={title}
      visitorOnline={live.visitorOnline}
      managing={managing}
      onBack={() => router.back()}
      onToggleState={() => void toggleState()}
    />
  );

  if (loading && !data) {
    return (
      <Screen header={header}>
        <LoadingState />
      </Screen>
    );
  }

  if (error && !data) {
    return (
      <Screen header={header}>
        <ErrorState message={t.conversation.loadError} onRetry={() => void load()} />
      </Screen>
    );
  }

  const messages = data?.messages ?? [];

  return (
    <Screen header={header} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={8}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.thread}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              {t.conversation.emptyThread}
            </Text>
          }
          renderItem={({ item }) => <MessageBubble message={item} />}
        />

        {live.typing.length > 0 ? (
          <Text style={[styles.typing, { color: colors.mutedForeground }]}>
            {format(t.conversation.typing, { name: live.typing[0] || t.conversation.typingFallback })}
          </Text>
        ) : null}

        <Composer
          mode={mode}
          body={body}
          sending={sending}
          onModeChange={setMode}
          onBodyChange={setBody}
          onTyping={live.notifyTyping}
          onSend={() => void send()}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

function eventLabel(t: Translations, eventType: unknown, body?: string | null) {
  switch (eventType) {
    case 'closed':
      return t.conversation.closedEvent;
    case 'reopened':
      return t.conversation.reopenedEvent;
    case 'assigned':
      return t.conversation.assignedEvent;
    case 'unassigned':
      return t.conversation.unassignedEvent;
    default:
      return body || t.conversation.system;
  }
}

function authorLabel(t: Translations, authorType: DeskMessage['authorType']) {
  switch (authorType) {
    case 'visitor':
      return t.conversation.visitor;
    case 'bot':
      return t.conversation.bot;
    case 'system':
      return t.conversation.system;
    default:
      return t.conversation.agent;
  }
}

function bubbleBackground(colors: ThemeColors, isNote: boolean, isAgent: boolean) {
  if (isNote) return 'rgba(245,158,11,0.15)';
  return isAgent ? BRAND : colors.secondary;
}

function MessageBubble({ message }: Readonly<{ message: DeskMessage }>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  if (message.kind === 'event') {
    const label = eventLabel(t, message.metadata?.eventType, message.body);

    return (
      <View style={styles.eventRow}>
        <Text style={[styles.eventText, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.eventTime, { color: colors.mutedForeground }]}>
          {formatShortTime(message.createdAt)}
        </Text>
      </View>
    );
  }

  const isAgent = message.authorType === 'agent' || message.authorType === 'bot';
  const isNote = message.kind === 'note';
  const onBrand = isAgent && !isNote;
  const author = authorLabel(t, message.authorType);

  return (
    <View
      style={[
        styles.bubbleWrap,
        isAgent ? styles.bubbleWrapAgent : styles.bubbleWrapVisitor,
      ]}
    >
      <View style={[styles.bubble, { backgroundColor: bubbleBackground(colors, isNote, isAgent) }]}>
        <Text
          style={[
            styles.author,
            { color: onBrand ? 'rgba(255,255,255,0.8)' : colors.mutedForeground },
          ]}
        >
          {author}
          {isNote ? ` · ${t.conversation.note}` : ''}
        </Text>
        <Text style={[styles.body, { color: onBrand ? '#fff' : colors.text }]}>
          {message.body || t.common.dash}
        </Text>
        <Text
          style={[
            styles.time,
            { color: onBrand ? 'rgba(255,255,255,0.7)' : colors.mutedForeground },
          ]}
        >
          {formatShortTime(message.createdAt)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaText: { fontSize: 13, fontWeight: '500' },
  online: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#10B981' },
  typing: { fontSize: 12, fontStyle: 'italic', paddingHorizontal: 16, paddingBottom: 4 },
  thread: { paddingHorizontal: 16, paddingVertical: 12, gap: 10, flexGrow: 1 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  bubbleWrap: { maxWidth: '85%' },
  bubbleWrapAgent: { alignSelf: 'flex-end' },
  bubbleWrapVisitor: { alignSelf: 'flex-start' },
  bubble: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  author: { fontSize: 11, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 20 },
  time: { fontSize: 11, marginTop: 2, alignSelf: 'flex-end' },
  eventRow: { alignItems: 'center', gap: 2, paddingVertical: 8 },
  eventText: { fontSize: 12, fontWeight: '500' },
  eventTime: { fontSize: 11 },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 22,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 8,
  },
  input: { flex: 1, maxHeight: 120, fontSize: 16, paddingVertical: 6 },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
