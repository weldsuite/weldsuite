import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useLocalSearchParams } from 'expo-router';
import { Send, Paperclip } from 'lucide-react-native';

interface Message {
  id: string;
  content: string;
  senderName: string;
  senderId: string;
  createdAt: string;
  isOwn: boolean;
}

export default function ProjectMessagesScreen() {
  const { colors } = useTheme();
  const { projectId } = useLocalSearchParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');

  useEffect(() => {
    loadMessages();
  }, [projectId]);

  const loadMessages = async () => {
    // Mock data
    const mockMessages: Message[] = [
      { id: '1', content: 'Hey team, just pushed the new design updates!', senderName: 'John', senderId: '1', createdAt: '10:30 AM', isOwn: false },
      { id: '2', content: 'Looks great! I\'ll start implementing the frontend.', senderName: 'You', senderId: 'me', createdAt: '10:32 AM', isOwn: true },
      { id: '3', content: 'Don\'t forget we have a deadline on Friday.', senderName: 'Sarah', senderId: '2', createdAt: '10:45 AM', isOwn: false },
      { id: '4', content: 'Got it, we\'re on track!', senderName: 'You', senderId: 'me', createdAt: '10:46 AM', isOwn: true },
    ];
    setMessages(mockMessages);
  };

  const handleSend = () => {
    if (!inputText.trim()) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      content: inputText,
      senderName: 'You',
      senderId: 'me',
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isOwn: true,
    };

    setMessages([...messages, newMessage]);
    setInputText('');
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      {/* Messages */}
      <ScrollView
        style={styles.messageList}
        contentContainerStyle={styles.messageListContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.map((message) => (
          <View
            key={message.id}
            style={[
              styles.messageRow,
              message.isOwn && styles.messageRowOwn,
            ]}
          >
            {!message.isOwn && (
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{getInitials(message.senderName)}</Text>
              </View>
            )}
            <View
              style={[
                styles.messageBubble,
                message.isOwn
                  ? { backgroundColor: '#111827' }
                  : { backgroundColor: colors.card, borderColor: colors.divider, borderWidth: 1 },
              ]}
            >
              {!message.isOwn && (
                <Text style={[styles.senderName, { color: colors.muted }]}>
                  {message.senderName}
                </Text>
              )}
              <Text
                style={[
                  styles.messageText,
                  { color: message.isOwn ? '#FFFFFF' : colors.text },
                ]}
              >
                {message.content}
              </Text>
              <Text
                style={[
                  styles.messageTime,
                  { color: message.isOwn ? 'rgba(255,255,255,0.6)' : colors.muted },
                ]}
              >
                {message.createdAt}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Input */}
      <View style={[styles.inputContainer, { backgroundColor: colors.card, borderTopColor: colors.divider }]}>
        <TouchableOpacity style={styles.attachButton}>
          <Paperclip size={20} color={colors.muted} strokeWidth={2} />
        </TouchableOpacity>
        <TextInput
          style={[styles.input, { color: colors.text }]}
          placeholder="Type a message..."
          placeholderTextColor={colors.muted}
          value={inputText}
          onChangeText={setInputText}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendButton, { opacity: inputText.trim() ? 1 : 0.5 }]}
          onPress={handleSend}
          disabled={!inputText.trim()}
        >
          <Send size={20} color="#FFFFFF" strokeWidth={2} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    padding: 16,
    gap: 12,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  messageRowOwn: {
    justifyContent: 'flex-end',
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6B7280',
  },
  messageBubble: {
    maxWidth: '75%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
  },
  senderName: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  messageText: {
    fontSize: 14,
    lineHeight: 20,
  },
  messageTime: {
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    borderTopWidth: 1,
    gap: 8,
  },
  attachButton: {
    padding: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    maxHeight: 100,
    paddingVertical: 8,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
