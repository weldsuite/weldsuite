import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Image,
  Platform,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Send, ChevronLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApi } from '@/services/app-api';

interface Message {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  createdAt: string;
}

export default function ThreadScreen() {
  const { messageId, channelId } = useLocalSearchParams<{ messageId: string; channelId: string }>();
  const [parentMessage, setParentMessage] = useState<Message | null>(null);
  const [replies, setReplies] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);

  useEffect(() => {
    loadThread();
  }, [messageId, channelId]);

  const loadThread = async () => {
    if (!channelId || !messageId) return;
    try {
      // Fetch the parent directly by id (it may be outside the channel's first
      // page) and its replies in parallel.
      const [parentRes, threadRes] = await Promise.all([
        appApi.chatMessages.get(messageId),
        appApi.chatMessages.list({ channelId, parentId: messageId }),
      ]);
      setParentMessage((parentRes.data ?? null) as unknown as Message | null);
      setReplies((threadRes.data ?? []) as unknown as Message[]);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSend = useCallback(async () => {
    if (!input.trim() || sending || !channelId || !messageId) return;
    setSending(true);
    try {
      await appApi.chatMessages.create({ channelId, parentId: messageId, body: input.trim() });
      setInput('');
      loadThread();
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }, [input, channelId, messageId, sending]);

  const renderMessage = ({ item, index }: { item: Message; index: number }) => (
    <>
      <View style={styles.message}>
        {item.authorAvatar ? (
          <Image source={{ uri: item.authorAvatar }} style={styles.avatarImg} />
        ) : (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(item.authorName || '?')[0].toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.content}>
          <View style={styles.header}>
            <Text style={styles.author}>{item.authorName}</Text>
            <Text style={styles.time}>
              {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          <Text style={styles.text}>{item.content}</Text>
        </View>
      </View>
      {index === 0 && parentMessage && replies.length > 0 && (
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </Text>
          <View style={styles.dividerLine} />
        </View>
      )}
    </>
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <ChevronLeft size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Thread</Text>
        </View>

        <FlatList
          ref={flatListRef}
          data={[...(parentMessage ? [parentMessage] : []), ...replies]}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={20}
          maxToRenderPerBatch={10}
          windowSize={10}
          removeClippedSubviews
          onLayout={() => flatListRef.current?.scrollToEnd({ animated: false })}
        />

        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Reply..."
            placeholderTextColor={colors.textMuted}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!input.trim() || sending}
          >
            <Send size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const makeStyles = (c: ColorScheme, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    topBar: {
      flexDirection: 'row', alignItems: 'center',
      paddingTop: topInset + 12, paddingHorizontal: 16, paddingBottom: 12,
      backgroundColor: c.bgTertiary, gap: 12,
    },
    backBtn: { padding: 8 },
    topBarTitle: { fontSize: 17, fontWeight: '700', color: c.textPrimary },
    list: { padding: 16, paddingBottom: 8, flexGrow: 1 },
    message: { flexDirection: 'row', marginBottom: 12 },
    avatarImg: { width: 36, height: 36, borderRadius: 18, marginRight: 10 },
    avatar: {
      width: 36, height: 36, borderRadius: 18,
      backgroundColor: c.brand, justifyContent: 'center', alignItems: 'center', marginRight: 10,
    },
    avatarText: { fontSize: 14, fontWeight: '700', color: '#fff' },
    content: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
    author: { fontSize: 15, fontWeight: '600', color: c.textPrimary, marginRight: 8 },
    time: { fontSize: 12, color: c.textMuted },
    text: { fontSize: 15, lineHeight: 22, color: c.textSecondary },
    divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, gap: 8 },
    dividerLine: { flex: 1, height: 1, backgroundColor: c.border },
    dividerText: { fontSize: 12, color: c.textMuted },
    inputBar: {
      flexDirection: 'row', alignItems: 'flex-end',
      padding: 12, paddingBottom: 12 + bottomInset,
      backgroundColor: c.bgTertiary,
    },
    input: {
      flex: 1, backgroundColor: c.inputBg, borderRadius: 20,
      paddingHorizontal: 16, paddingVertical: 10, fontSize: 15,
      maxHeight: 100, marginRight: 8, color: c.textPrimary,
    },
    sendBtn: {
      width: 44, height: 44, borderRadius: 22,
      backgroundColor: c.brand, justifyContent: 'center', alignItems: 'center',
    },
    sendBtnDisabled: { opacity: 0.4 },
  });
