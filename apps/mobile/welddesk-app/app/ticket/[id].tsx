import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator,
  TextInput, TouchableOpacity, Platform,
  ActionSheetIOS, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Send, MoreVertical, Circle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { formatShortTime } from '@weldsuite/mobile-ui/utils/dateFormatter';
import { useHelpdeskRealtime } from '@/hooks/useHelpdeskRealtime';
import api from '@/services/api';

const STATUS_LABELS: Record<string, string> = {
  active: 'Open', pending: 'Pending', snoozed: 'Snoozed', resolved: 'Resolved', closed: 'Closed',
};

export default function TicketDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useClerkAuth();
  const flatListRef = useRef<FlatList>(null);

  const [conversation, setConversation] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [typingUser, setTypingUser] = useState('');
  const [customerOnline, setCustomerOnline] = useState(false);

  const agentId = user?.id || '';
  const agentName = user?.fullName || user?.firstName || 'Agent';

  // Load conversation + messages
  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      const [convRes, msgRes] = await Promise.all([
        api.getConversation(id),
        api.getConversationMessages(id, { limit: 100 }),
      ]);
      if (convRes.success) setConversation(convRes.data);
      if (msgRes.success && msgRes.data) {
        const items = msgRes.data.items || msgRes.data.data || msgRes.data;
        setMessages(Array.isArray(items) ? items.reverse() : []);
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  // Mark as read when conversation opens
  useEffect(() => {
    if (id) { api.markConversationAsRead(id).catch(() => {}); }
  }, [id]);

  // Real-time
  const {
    isConnected,
    sendTypingIndicator,
  } = useHelpdeskRealtime({
    conversationId: id || '',
    agentId,
    agentName,
    onMessage: (msg) => {
      // Don't add our own messages (already added optimistically)
      if (msg.senderId === agentId) return;
      setMessages((prev) => [{
        id: msg.id,
        content: msg.content,
        sender: msg.sender,
        senderName: msg.senderName,
        authorType: msg.sender,
        createdAt: msg.timestamp,
      }, ...prev]);
    },
    onTyping: (indicator) => {
      setIsTyping(indicator.isTyping);
      setTypingUser(indicator.userName || 'Customer');
    },
    onConversationClosed: () => {
      setConversation((prev: any) => prev ? { ...prev, status: 'closed' } : prev);
    },
    onAgentAssigned: (agent) => {
      setConversation((prev: any) => prev ? { ...prev, assigneeId: agent.agentId, assigneeName: agent.agentName } : prev);
    },
    onPresenceChange: (member) => {
      if ((member.data as any)?.type === 'customer') setCustomerOnline(true);
    },
    autoConnect: !loading && !!id && !!agentId,
  });

  // Send message
  const handleSend = async () => {
    if (!messageText.trim() || sending) return;
    const text = messageText.trim();
    setSending(true);
    setMessageText('');
    sendTypingIndicator(false);

    // Optimistic add
    const tempId = `temp_${Date.now()}`;
    setMessages((prev) => [{ id: tempId, content: text, authorType: 'agent', senderName: agentName, createdAt: new Date().toISOString() }, ...prev]);

    try {
      const response = await api.replyToConversation(id!, { content: text });
      if (response.success && response.data) {
        // Replace temp with real
        setMessages((prev) => prev.map((m) => m.id === tempId ? { ...response.data, authorType: 'agent' } : m));
      }
    } catch (error) {
      // Mark as failed
      setMessages((prev) => prev.map((m) => m.id === tempId ? { ...m, failed: true } : m));
    } finally {
      setSending(false);
    }
  };

  // Typing
  const handleTextChange = (text: string) => {
    setMessageText(text);
    sendTypingIndicator(text.length > 0);
  };

  // Action sheet
  const showActions = () => {
    const status = conversation?.status;
    const options = ['Cancel'];
    const actions: (() => void)[] = [];

    if (status !== 'closed') {
      options.push('Close Conversation');
      actions.push(() => updateStatus('closed'));
    }
    if (status === 'closed' || status === 'resolved') {
      options.push('Reopen');
      actions.push(() => updateStatus('active'));
    }
    options.push('Set High Priority');
    actions.push(() => updatePriority('high'));
    options.push('Set Low Priority');
    actions.push(() => updatePriority('low'));

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: 0, destructiveButtonIndex: status !== 'closed' ? 1 : undefined },
        (index) => { if (index > 0) actions[index - 1]?.(); },
      );
    } else {
      // Android fallback
      Alert.alert('Actions', undefined, [
        { text: 'Cancel', style: 'cancel' },
        ...actions.map((fn, i) => ({ text: options[i + 1], onPress: fn })),
      ]);
    }
  };

  const updateStatus = async (status: string) => {
    try {
      await api.updateConversationStatus(id!, status);
      setConversation((prev: any) => prev ? { ...prev, status } : prev);
    } catch (error) {
      console.error('Failed to update status:', error);
    }
  };

  const updatePriority = async (priority: string) => {
    try {
      await api.updateConversationPriority(id!, priority);
      setConversation((prev: any) => prev ? { ...prev, priority } : prev);
    } catch (error) {
      console.error('Failed to update priority:', error);
    }
  };

  if (loading) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.text} /></View>;
  }

  const isClosed = conversation?.status === 'closed' || conversation?.status === 'resolved';

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: colors.background }]} behavior="padding" keyboardVerticalOffset={0}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <View style={styles.headerTitleRow}>
            <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
              {conversation?.contactName || conversation?.customerName || 'Conversation'}
            </Text>
            {customerOnline && <Circle size={8} fill="#10B981" color="#10B981" />}
          </View>
          <Text style={[styles.headerSubtitle, { color: colors.muted }]}>
            {STATUS_LABELS[conversation?.status] || conversation?.status}
            {conversation?.subject ? ` \u00B7 ${conversation.subject}` : ''}
          </Text>
        </View>
        <TouchableOpacity onPress={showActions} hitSlop={10}>
          <MoreVertical size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        inverted
        contentContainerStyle={{ paddingVertical: 8 }}
        renderItem={({ item }) => {
          const isAgent = item.authorType === 'agent' || item.sender === 'agent';
          const isSystem = item.authorType === 'system';
          if (isSystem) {
            return (
              <View style={styles.systemMessage}>
                <Text style={[styles.systemText, { color: colors.muted }]}>{item.content}</Text>
              </View>
            );
          }
          return (
            <View style={[styles.messageBubble, isAgent ? styles.agentBubble : styles.customerBubble]}>
              <View style={[
                styles.bubble,
                { backgroundColor: isAgent ? '#3B82F6' : colors.card },
                item.failed && { opacity: 0.5 },
              ]}>
                <Text style={[styles.messageContent, { color: isAgent ? '#fff' : colors.text }]}>
                  {item.content}
                </Text>
              </View>
              <View style={[styles.messageFooter, isAgent ? styles.agentFooter : styles.customerFooter]}>
                <Text style={[styles.messageMeta, { color: colors.muted }]}>
                  {item.senderName || item.authorName || (isAgent ? 'Agent' : 'Customer')}
                  {item.createdAt ? ` \u00B7 ${formatShortTime(item.createdAt)}` : ''}
                </Text>
                {item.failed && <Text style={styles.failedText}>Failed</Text>}
              </View>
            </View>
          );
        }}
      />

      {/* Typing indicator */}
      {isTyping && (
        <View style={[styles.typingBar, { backgroundColor: colors.background }]}>
          <Text style={[styles.typingText, { color: colors.muted }]}>{typingUser} is typing...</Text>
        </View>
      )}

      {/* Input */}
      {isClosed ? (
        <View style={[styles.closedBar, { paddingBottom: insets.bottom + 8, borderTopColor: colors.divider }]}>
          <Text style={[styles.closedText, { color: colors.muted }]}>This conversation is {conversation?.status}</Text>
          <TouchableOpacity onPress={() => updateStatus('active')}>
            <Text style={styles.reopenText}>Reopen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8, borderTopColor: colors.divider, backgroundColor: colors.background }]}>
          <TextInput
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
            value={messageText}
            onChangeText={handleTextChange}
            placeholder="Type a message..."
            placeholderTextColor={colors.muted}
            multiline
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSend} disabled={!messageText.trim() || sending}>
            <Send size={20} color={messageText.trim() ? '#3B82F6' : colors.muted} />
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 0.5, gap: 12 },
  headerInfo: { flex: 1 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  headerSubtitle: { fontSize: 13, marginTop: 2 },
  messageBubble: { paddingHorizontal: 16, marginVertical: 2 },
  agentBubble: { alignItems: 'flex-end' },
  customerBubble: { alignItems: 'flex-start' },
  bubble: { maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  messageContent: { fontSize: 15, lineHeight: 21 },
  messageFooter: { marginTop: 2, paddingHorizontal: 4 },
  agentFooter: { alignItems: 'flex-end' },
  customerFooter: { alignItems: 'flex-start' },
  messageMeta: { fontSize: 11 },
  failedText: { fontSize: 11, color: '#EF4444', marginTop: 2 },
  systemMessage: { paddingVertical: 8, paddingHorizontal: 16, alignItems: 'center' },
  systemText: { fontSize: 13, fontStyle: 'italic' },
  typingBar: { paddingHorizontal: 16, paddingVertical: 6 },
  typingText: { fontSize: 13, fontStyle: 'italic' },
  closedBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 0.5 },
  closedText: { fontSize: 14 },
  reopenText: { fontSize: 14, color: '#3B82F6', fontWeight: '600' },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 0.5, gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120 },
  sendButton: { paddingBottom: 10 },
});
