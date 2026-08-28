/**
 * Conversation thread — reply / note / close, same actions as the platform pane.
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Send, CheckCircle2, RotateCcw } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { formatShortTime } from '@weldsuite/mobile-ui/utils/dateFormatter';

import api from '@/services/api';
import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { ErrorState, LoadingState } from '@/components/data-states';
import { ChannelBadge, ConversationStateBadge } from '@/components/status-badge';
import { useI18n } from '@/lib/i18n';
import type { DeskConversationWithMessages, DeskMessage } from '@/types/desk';

type ComposerMode = 'message' | 'note';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useI18n();
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

  const send = useCallback(async () => {
    if (!id || !body.trim() || sending) return;
    setSending(true);
    try {
      const res = await api.replyToConversation(id, { kind: mode, body: body.trim() });
      if (!res.success) {
        setError(true);
        return;
      }
      setBody('');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await load();
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  }, [id, body, mode, sending, load]);

  const toggleState = useCallback(async () => {
    if (!id || !data || managing) return;
    setManaging(true);
    try {
      const action = data.state === 'open' ? 'close' : 'open';
      const res = await api.manageConversation(id, { action });
      if (!res.success) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await load();
    } finally {
      setManaging(false);
    }
  }, [id, data, managing, load]);

  const title =
    data?.name || data?.email || (data ? `#${data.conversationNumber}` : t.conversation.title);

  const header = (
    <ScreenHeader
      title={title}
      subtitle={data?.email ?? undefined}
      onBack={() => router.back()}
      actions={
        data ? (
          <>
            <IconButton
              icon={
                data.state === 'open' ? (
                  <CheckCircle2 size={20} color={colors.text} />
                ) : (
                  <RotateCcw size={20} color={colors.text} />
                )
              }
              accessibilityLabel={data.state === 'open' ? t.conversation.close : t.conversation.reopen}
              onPress={() => void toggleState()}
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
          </View>
        ) : null
      }
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

        <View style={[styles.composer, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <View style={styles.modeRow}>
            {(['message', 'note'] as const).map((m) => {
              const active = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setMode(m)}
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
              onChangeText={setBody}
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
              onPress={() => void send()}
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
      </KeyboardAvoidingView>
    </Screen>
  );
}

function MessageBubble({ message }: { message: DeskMessage }) {
  const { colors } = useTheme();
  const { t } = useI18n();

  if (message.kind === 'event') {
    const eventType = message.metadata?.eventType;
    const label =
      eventType === 'closed'
        ? t.conversation.closedEvent
        : eventType === 'reopened'
          ? t.conversation.reopenedEvent
          : eventType === 'assigned'
            ? t.conversation.assignedEvent
            : eventType === 'unassigned'
              ? t.conversation.unassignedEvent
              : message.body || t.conversation.system;

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
  const author =
    message.authorType === 'visitor'
      ? t.conversation.visitor
      : message.authorType === 'bot'
        ? t.conversation.bot
        : message.authorType === 'system'
          ? t.conversation.system
          : t.conversation.agent;

  return (
    <View
      style={[
        styles.bubbleWrap,
        isAgent ? styles.bubbleWrapAgent : styles.bubbleWrapVisitor,
      ]}
    >
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: isNote
              ? 'rgba(245,158,11,0.15)'
              : isAgent
                ? BRAND
                : colors.secondary,
          },
        ]}
      >
        <Text
          style={[
            styles.author,
            { color: isAgent && !isNote ? 'rgba(255,255,255,0.8)' : colors.mutedForeground },
          ]}
        >
          {author}
          {isNote ? ` · ${t.conversation.note}` : ''}
        </Text>
        <Text
          style={[
            styles.body,
            { color: isAgent && !isNote ? '#fff' : colors.text },
          ]}
        >
          {message.body || t.common.dash}
        </Text>
        <Text
          style={[
            styles.time,
            { color: isAgent && !isNote ? 'rgba(255,255,255,0.7)' : colors.mutedForeground },
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
