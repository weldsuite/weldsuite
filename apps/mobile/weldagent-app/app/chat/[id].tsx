import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Send } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen, ScreenHeader } from '@/components/screen';
import { ErrorState, LoadingState } from '@/components/data-states';
import { useI18n } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import appApi from '@/services/app-api';
import { isApiError } from '@weldsuite/api-client/client';
import type { WeldAgentMessageRow } from '@weldsuite/app-api-client/schemas/weldagent';

export default function ChatThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const scrollRef = useRef<ScrollView>(null);

  const [title, setTitle] = useState(t.chat.title);
  const [messages, setMessages] = useState<WeldAgentMessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditsEmpty, setCreditsEmpty] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [convs, msgs] = await Promise.all([
        appApi.weldagent.listConversations(50),
        appApi.weldagent.listMessages(id, { limit: 200 }),
      ]);
      const conv = (convs.data ?? []).find((c) => c.id === id);
      if (conv) setTitle(conv.name);
      setMessages(msgs.data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages, sending]);

  const send = async () => {
    const content = draft.trim();
    if (!content || !id || sending) return;
    setDraft('');
    setSending(true);
    setCreditsEmpty(false);
    try {
      const res = await appApi.weldagent.completeTurn(id, { content });
      setMessages((prev) => [...prev, res.data.userMessage, res.data.assistantMessage]);
      if (messages.length === 0) {
        void appApi.weldagent.autoTitleConversation(id, { firstUserMessage: content }).then((r) => {
          if (r.data?.name) setTitle(r.data.name);
        });
      }
    } catch (err) {
      if (isApiError(err) && err.status === 402) {
        setCreditsEmpty(true);
        setDraft(content);
      } else {
        setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
        setDraft(content);
      }
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <Screen header={<ScreenHeader title={t.chat.title} showBack />}>
        <LoadingState />
      </Screen>
    );
  }

  if (error && messages.length === 0) {
    return (
      <Screen header={<ScreenHeader title={t.chat.title} showBack />}>
        <ErrorState message={error} onRetry={() => void load()} />
      </Screen>
    );
  }

  return (
    <Screen header={<ScreenHeader title={title} showBack />} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={8}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.thread}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 && !sending ? (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>{t.chat.empty}</Text>
          ) : null}
          {messages.map((msg) => {
            const mine = msg.role === 'user';
            return (
              <View
                key={msg.id}
                style={[
                  styles.bubble,
                  mine ? [styles.mine, { backgroundColor: BRAND }] : [styles.theirs, { backgroundColor: colors.secondary }],
                ]}
              >
                <Text style={[styles.bubbleText, { color: mine ? '#fff' : colors.text }]}>{msg.content}</Text>
              </View>
            );
          })}
          {sending ? (
            <View style={[styles.bubble, styles.theirs, { backgroundColor: colors.secondary }]}>
              <Text style={[styles.bubbleText, { color: colors.mutedForeground }]}>{t.common.thinking}</Text>
            </View>
          ) : null}
          {creditsEmpty ? (
            <Pressable onPress={() => router.push('/credits')} style={styles.creditsWarn}>
              <Text style={[styles.creditsText, { color: colors.destructive }]}>{t.chat.creditsEmpty}</Text>
              <Text style={[styles.creditsLink, { color: BRAND }]}>{t.chat.topUp}</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        <View
          style={[
            styles.composer,
            {
              backgroundColor: colors.background,
              borderTopColor: colors.border,
              paddingBottom: Math.max(insets.bottom, 8),
            },
          ]}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t.chat.composerPlaceholder}
            placeholderTextColor={colors.mutedForeground}
            multiline
            style={[styles.input, { color: colors.text, backgroundColor: colors.secondary }]}
            editable={!sending}
          />
          <Pressable
            onPress={() => void send()}
            disabled={sending || !draft.trim()}
            accessibilityRole="button"
            accessibilityLabel={t.common.send}
            style={[styles.send, { backgroundColor: BRAND, opacity: sending || !draft.trim() ? 0.5 : 1 }]}
          >
            <Send size={18} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  thread: { paddingHorizontal: 16, paddingVertical: 12, gap: 8, flexGrow: 1 },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 14 },
  bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  mine: { alignSelf: 'flex-end' },
  theirs: { alignSelf: 'flex-start' },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  creditsWarn: { padding: 12, gap: 4 },
  creditsText: { fontSize: 14, lineHeight: 20 },
  creditsLink: { fontSize: 14, fontWeight: '600' },
});
