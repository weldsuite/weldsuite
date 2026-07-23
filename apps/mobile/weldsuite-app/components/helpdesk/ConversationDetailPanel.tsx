import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Keyboard,
  Platform,
  Modal,
  Pressable,
  ScrollView,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Lock, Inbox, ArrowUp, Clock, Star, Forward, Archive, Trash2, Ticket, MessageSquare } from 'lucide-react-native';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useUser } from '@clerk/expo';
import api, { ConversationDetail, ConversationMessage as ApiConversationMessage, getApiErrorMessage } from '@/services/api';
import { useHelpdeskRealtime } from '@/hooks/useHelpdeskRealtime';
import { TypingIndicator } from './TypingIndicator';
import { ChatSkeleton } from './Skeleton';
import type { RealtimeMessage, TypingIndicator as TypingIndicatorType, PresenceMember } from '@/hooks/useHelpdeskRealtime';

interface Message {
  id: string;
  text: string;
  sender: 'customer' | 'agent';
  senderName: string;
  timestamp: string;
  isRead?: boolean;
  isInternal?: boolean;
}

interface ConversationDetailPanelProps {
  conversationId: string | null;
  onClose?: () => void;
  showBackButton?: boolean;
  isEmbedded?: boolean;
}

export default function ConversationDetailPanel({
  conversationId,
  onClose,
  showBackButton = false,
  isEmbedded = false,
}: ConversationDetailPanelProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { user } = useUser();
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Map<string, TypingIndicatorType>>(new Map());
  const [customerOnline, setCustomerOnline] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; userId: string; name: string; email: string; role: string; availability: string }>>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [closing, setClosing] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // Handle keyboard events
  useEffect(() => {
    const keyboardWillShow = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const keyboardWillHide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
      }
    );

    return () => {
      keyboardWillShow.remove();
      keyboardWillHide.remove();
    };
  }, []);

  const agentId = user?.id || '';
  const agentName = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Agent';
  const agentEmail = user?.primaryEmailAddress?.emailAddress;
  const agentAvatar = user?.imageUrl;

  const handleRealtimeMessage = useCallback((message: RealtimeMessage) => {
    if (message.senderId === agentId) return;

    const newMessage: Message = {
      id: message.id || `msg-${Date.now()}`,
      text: message.content,
      sender: message.sender === 'customer' ? 'customer' : 'agent',
      senderName: message.senderName || 'Unknown',
      timestamp: message.timestamp,
      isRead: message.isRead ?? false,
      isInternal: false,
    };

    setMessages(prev => [...prev, newMessage]);

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [agentId]);

  const handleTyping = useCallback((indicator: TypingIndicatorType) => {
    if (indicator.userType === 'customer') {
      if (indicator.isTyping) {
        setTypingUsers(prev => new Map(prev).set(indicator.userId, indicator));
        setTimeout(() => {
          setTypingUsers(prev => {
            const next = new Map(prev);
            next.delete(indicator.userId);
            return next;
          });
        }, 3000);
      } else {
        setTypingUsers(prev => {
          const next = new Map(prev);
          next.delete(indicator.userId);
          return next;
        });
      }
    }
  }, []);

  const handlePresenceChange = useCallback((member: PresenceMember, action: 'enter' | 'leave' | 'update') => {
    if (member.data?.type === 'customer') {
      setCustomerOnline(action !== 'leave');
    }
  }, []);

  const {
    isConnected,
    sendMessage: sendRealtimeMessage,
    sendTypingIndicator,
    getPresenceMembers,
  } = useHelpdeskRealtime({
    conversationId: conversationId || '',
    agentId,
    agentName,
    agentEmail,
    agentAvatar,
    onMessage: handleRealtimeMessage,
    onTyping: handleTyping,
    onPresenceChange: handlePresenceChange,
    autoConnect: !loading && !!conversationId && !!agentId,
  });

  useEffect(() => {
    if (isConnected) {
      getPresenceMembers().then(members => {
        setCustomerOnline(members.some(m => m.data?.type === 'customer'));
      });
    }
  }, [isConnected, getPresenceMembers]);

  useEffect(() => {
    if (conversationId) {
      loadConversationData();
    } else {
      setConversation(null);
      setMessages([]);
      setLoading(false);
    }
  }, [conversationId]);

  const loadConversationData = async () => {
    if (!conversationId) return;

    try {
      setLoading(true);
      const conversationResponse = await api.getConversation(conversationId);

      if (conversationResponse.success && conversationResponse.data) {
        setConversation(conversationResponse.data);

        // Mark conversation as read
        api.markConversationAsRead(conversationId).catch(() => {});

        const messagesResponse = await api.getConversationMessages(conversationId);

        if (messagesResponse.success && messagesResponse.data) {
          // mobile-api-worker returns paginated response with items array
          const messageList = messagesResponse.data.items || [];

          const formattedMessages: Message[] = messageList.map((msg) => ({
            id: msg.id,
            text: msg.content,
            sender: msg.authorType === 'customer' ? 'customer' : 'agent',
            senderName: msg.authorName || 'Unknown',
            timestamp: msg.createdAt,
            isRead: true,
            isInternal: msg.isInternal,
          }));

          setMessages(formattedMessages);
        }
      } else {
        toast.error(getApiErrorMessage(conversationResponse.error, 'Failed to load conversation'));
      }
    } catch (error) {
      console.error('Error loading conversation:', error);
      toast.error('Failed to load conversation');
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const handleInputChange = (text: string) => {
    setInputText(text);
    if (!isInternalNote && text.length > 0) {
      sendTypingIndicator(true);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !conversationId || sending) return;

    const messageText = inputText.trim();
    const wasInternalNote = isInternalNote;
    setInputText('');
    setSending(true);

    sendTypingIndicator(false);

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: Message = {
      id: tempId,
      text: messageText,
      sender: 'agent',
      senderName: 'You',
      timestamp: new Date().toISOString(),
      isRead: false,
      isInternal: wasInternalNote,
    };
    setMessages(prev => [...prev, optimisticMessage]);

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      const response = await api.sendConversationMessage(conversationId, messageText, wasInternalNote);

      if (response.success && response.data) {
        const serverMessage: Message = {
          id: response.data.id,
          text: response.data.content || messageText,
          sender: 'agent',
          senderName: response.data.authorName || 'Agent',
          timestamp: response.data.createdAt || new Date().toISOString(),
          isRead: false,
          isInternal: response.data.isInternal,
        };

        setMessages(prev => prev.map(msg =>
          msg.id === tempId ? serverMessage : msg
        ));

        if (!wasInternalNote && isConnected) {
          try {
            await sendRealtimeMessage(messageText);
          } catch (rtError) {
            console.warn('Failed to send via realtime:', rtError);
          }
        }
      } else {
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        toast.error(getApiErrorMessage(response.error, 'Failed to send message'));
        setInputText(messageText);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages(prev => prev.filter(msg => msg.id !== tempId));
      toast.error('Failed to send message');
      setInputText(messageText);
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    const isCustomer = item.sender === 'customer';
    const prevMessage = index > 0 ? messages[index - 1] : null;
    const nextMessage = index < messages.length - 1 ? messages[index + 1] : null;

    const isGroupedWithPrev = prevMessage &&
      prevMessage.sender === item.sender &&
      (new Date(item.timestamp).getTime() - new Date(prevMessage.timestamp).getTime()) < 5 * 60 * 1000;

    const isGroupedWithNext = nextMessage &&
      nextMessage.sender === item.sender &&
      (new Date(nextMessage.timestamp).getTime() - new Date(item.timestamp).getTime()) < 5 * 60 * 1000;

    const isInternal = item.isInternal === true;
    const bubbleColor = isInternal ? '#FEF3C7' : isCustomer ? '#F3F4F6' : '#3B82F6';
    const textColor = isInternal ? '#92400E' : isCustomer ? colors.text : '#FFFFFF';
    const timeColor = isInternal ? '#B45309' : isCustomer ? colors.muted : '#E0E7FF';

    return (
      <View style={[
        styles.messageContainer,
        isCustomer ? styles.customerMessage : styles.agentMessage,
        isGroupedWithNext && styles.groupedMessage,
      ]}>
        {isInternal && (
          <View style={styles.internalLabel}>
            <Lock size={10} color="#92400E" />
            <Text style={styles.internalLabelText}>Internal Note</Text>
          </View>
        )}
        <View style={[
          styles.messageBubble,
          {
            backgroundColor: bubbleColor,
            borderWidth: isInternal ? 1 : 0,
            borderColor: isInternal ? '#FCD34D' : 'transparent',
          }
        ]}>
          <Text style={[styles.messageText, { color: textColor }]}>
            {item.text}
          </Text>
          <Text style={[styles.messageTime, { color: timeColor }]}>
            {formatTime(item.timestamp)}
          </Text>
        </View>
      </View>
    );
  };

  // Empty state when no conversation selected
  if (!conversationId) {
    return (
      <View style={[styles.emptyContainer, { backgroundColor: colors.background }]}>
        <View style={styles.emptyContent}>
          <Inbox size={48} color={colors.muted} strokeWidth={1.5} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No conversation selected</Text>
          <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
            Select a conversation from the list to view details
          </Text>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ChatSkeleton />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.divider, paddingTop: isEmbedded ? 16 : insets.top + 10 }]}>
        {showBackButton && (
          <TouchableOpacity onPress={onClose} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        )}
        <View style={styles.headerContent}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {conversation?.contactName || conversation?.customerName || 'Conversation'}
          </Text>
          <View style={styles.headerMeta}>
            <Text style={[styles.headerSubtitle, { color: colors.muted, flex: 1 }]} numberOfLines={1}>
              {conversation?.subject || 'No subject'}
            </Text>
            {conversation?.assigneeId && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EFF6FF', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                <Text style={{ fontSize: 10, fontWeight: '600', color: '#2563EB' }}>
                  {conversation.assigneeId === user?.id ? 'You' : conversation.assigneeName || 'Agent'}
                </Text>
              </View>
            )}
            {customerOnline && (
              <View style={styles.onlineIndicator}>
                <View style={styles.onlineDot} />
                <Text style={styles.onlineText}>Online</Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.actionsButton}
            onPress={() => setShowActionSheet(true)}
          >
            <Text style={[styles.actionsButtonText, { color: colors.text }]}>Actions</Text>
          </TouchableOpacity>
          {conversation?.status !== 'closed' && (
          <TouchableOpacity
            style={[styles.closeButton, closing && { opacity: 0.5 }]}
            disabled={closing}
            onPress={async () => {
              if (!conversationId || closing) return;
              setClosing(true);
              try {
                const response = await api.closeConversation(conversationId);
                if (response.success) {
                  toast.success('Conversation closed');
                  onClose?.();
                } else {
                  toast.error(getApiErrorMessage(response.error, 'Failed to close conversation'));
                  setClosing(false);
                }
              } catch (error) {
                toast.error('Failed to close conversation');
                setClosing(false);
              }
            }}
          >
            {closing ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Text style={[styles.closeButtonText, { color: colors.text }]}>Close</Text>
            )}
          </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messagesList}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
      />

      {/* Typing Indicator */}
      {typingUsers.size > 0 && (
        <View style={styles.typingContainer}>
          <TypingIndicator />
          <Text style={[styles.typingText, { color: colors.muted }]}>
            Customer is typing...
          </Text>
        </View>
      )}

      {conversation?.status === 'closed' || conversation?.status === 'resolved' ? (
        <View style={{ backgroundColor: '#F9FAFB', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E7EB', paddingBottom: isEmbedded ? 20 : insets.bottom + 10 }}>
          <View style={styles.closedBanner}>
            <Lock size={14} color="#6B7280" />
            <Text style={styles.closedBannerText}>
              This conversation has been {conversation.status === 'resolved' ? 'resolved' : 'closed'}
            </Text>
          </View>
        </View>
      ) : (
        <>
          {/* Note Toggle */}
          <View style={styles.noteToggleContainer}>
            <TouchableOpacity
              style={[styles.noteToggleButton, !isInternalNote && styles.noteToggleActive]}
              onPress={() => setIsInternalNote(false)}
            >
              <MessageSquare size={14} color={!isInternalNote ? '#3B82F6' : '#6B7280'} />
              <Text style={[styles.noteToggleText, { color: !isInternalNote ? '#3B82F6' : '#6B7280' }]}>Reply</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.noteToggleButton, isInternalNote && styles.noteToggleActiveNote]}
              onPress={() => setIsInternalNote(true)}
            >
              <Lock size={14} color={isInternalNote ? '#92400E' : '#6B7280'} />
              <Text style={[styles.noteToggleText, { color: isInternalNote ? '#92400E' : '#6B7280' }]}>Internal Note</Text>
            </TouchableOpacity>
          </View>

          {/* Input */}
          <View style={[
            styles.inputContainer,
            {
              borderTopColor: colors.divider,
              backgroundColor: isInternalNote ? '#FEF3C7' : undefined,
              paddingBottom: keyboardHeight > 0 ? keyboardHeight - insets.bottom - 34 : (isEmbedded ? 20 : insets.bottom + 10)
            }
          ]}>
            {/* ChatGPT-style input */}
            <View style={styles.chatInputWrapper}>
              <TextInput
                style={styles.chatInput}
                placeholder="Add a comment..."
                placeholderTextColor="#9CA3AF"
                value={inputText}
                onChangeText={handleInputChange}
                multiline
                maxLength={5000}
              />
              <TouchableOpacity
                style={[
                  styles.chatSendButton,
                  inputText.trim() && styles.chatSendButtonActive,
                ]}
                onPress={handleSend}
                disabled={!inputText.trim() || sending}
              >
                <ArrowUp size={16} color={inputText.trim() ? '#FFFFFF' : '#9CA3AF'} strokeWidth={2.5} />
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

      {/* Action Sheet Modal */}
      <Modal
        visible={showActionSheet}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowActionSheet(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowActionSheet(false)}
        >
          <View style={styles.actionSheet}>
            <View style={styles.actionSheetHandle}>
              <View style={styles.actionSheetHandleLine} />
            </View>

            <TouchableOpacity
              style={styles.actionSheetItem}
              onPress={async () => {
                setShowActionSheet(false);
                try {
                  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                  const response = await api.snoozeConversation(conversationId!, snoozedUntil);
                  if (response.success) {
                    toast.success('Conversation snoozed for 1 hour');
                    onClose?.();
                  } else {
                    toast.error(getApiErrorMessage(response.error, 'Failed to snooze'));
                  }
                } catch (error) {
                  toast.error('Failed to snooze conversation');
                }
              }}
            >
              <Clock size={20} color="#000000" />
              <Text style={styles.actionSheetText}>Snooze</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionSheetItem}
              onPress={async () => {
                setShowActionSheet(false);
                try {
                  const isStarred = conversation?.isStarred;
                  const response = isStarred
                    ? await api.unstarConversation(conversationId!)
                    : await api.starConversation(conversationId!);
                  if (response.success) {
                    setConversation(prev => prev ? { ...prev, isStarred: !isStarred } : prev);
                    toast.success(isStarred ? 'Star removed' : 'Conversation starred');
                  } else {
                    toast.error(getApiErrorMessage(response.error, 'Failed to update star'));
                  }
                } catch (error) {
                  toast.error('Failed to update star');
                }
              }}
            >
              <Star size={20} color={conversation?.isStarred ? '#F59E0B' : '#000000'} fill={conversation?.isStarred ? '#F59E0B' : 'none'} />
              <Text style={styles.actionSheetText}>{conversation?.isStarred ? 'Unstar' : 'Star'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionSheetItem}
              onPress={async () => {
                setShowActionSheet(false);
                setLoadingAgents(true);
                try {
                  const result = await api.getAgents();
                  if (result.success && result.data) {
                    setAgents(result.data.filter(a => a.userId !== user?.id));
                  }
                } catch {} finally {
                  setLoadingAgents(false);
                }
                setShowTransferModal(true);
              }}
            >
              <Forward size={20} color="#000000" />
              <Text style={styles.actionSheetText}>Transfer</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionSheetItem}
              onPress={async () => {
                setShowActionSheet(false);
                try {
                  const response = await api.archiveConversation(conversationId!);
                  if (response.success) {
                    toast.success('Conversation archived');
                    onClose?.();
                  } else {
                    toast.error(getApiErrorMessage(response.error, 'Failed to archive'));
                  }
                } catch (error) {
                  toast.error('Failed to archive conversation');
                }
              }}
            >
              <Archive size={20} color="#000000" />
              <Text style={styles.actionSheetText}>Archive</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionSheetItem}
              onPress={() => {
                setShowActionSheet(false);
                router.push(`/helpdesk/ticket/new?conversationId=${conversationId}` as any);
              }}
            >
              <Ticket size={20} color="#000000" />
              <Text style={styles.actionSheetText}>Create Ticket</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionSheetItem}
              onPress={() => {
                setShowActionSheet(false);
                Alert.alert(
                  'Delete Conversation',
                  'Are you sure you want to delete this conversation? This action cannot be undone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          const response = await api.updateConversationStatus(conversationId!, 'closed');
                          if (response.success) {
                            toast.success('Conversation deleted');
                            onClose?.();
                          } else {
                            toast.error(getApiErrorMessage(response.error, 'Failed to delete'));
                          }
                        } catch (error) {
                          toast.error('Failed to delete conversation');
                        }
                      },
                    },
                  ]
                );
              }}
            >
              <Trash2 size={20} color="#EF4444" />
              <Text style={[styles.actionSheetText, { color: '#EF4444' }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Transfer Modal */}
      <Modal
        visible={showTransferModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowTransferModal(false)}
      >
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingTop: 16, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text, marginLeft: 16 }}>Transfer Conversation</Text>
            <TouchableOpacity onPress={() => setShowTransferModal(false)} style={{ padding: 4, marginRight: 16 }}>
              <ChevronLeft size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1, paddingHorizontal: 20, paddingTop: 8 }} showsVerticalScrollIndicator={false}>
            {loadingAgents ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={colors.text} />
              </View>
            ) : agents.length === 0 ? (
              <Text style={{ color: colors.muted, fontSize: 14, textAlign: 'center', paddingVertical: 40 }}>No other agents available</Text>
            ) : (
              agents.map(agent => (
                <TouchableOpacity
                  key={agent.id}
                  style={{ paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: colors.divider }}
                  onPress={async () => {
                    setShowTransferModal(false);
                    try {
                      const response = await api.assignConversation(conversationId!, agent.userId, agent.name);
                      if (response.success) {
                        setConversation(prev => prev ? { ...prev, assigneeId: agent.userId, assigneeName: agent.name } : prev);
                        toast.success(`Transferred to ${agent.name}`);
                      } else {
                        toast.error(getApiErrorMessage(response.error, 'Failed to transfer'));
                      }
                    } catch {
                      toast.error('Failed to transfer conversation');
                    }
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '500', color: colors.text }}>{agent.name}</Text>
                  <Text style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{agent.email}</Text>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContent: {
    alignItems: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 280,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
    gap: 12,
  },
  backButton: {
    padding: 4,
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  headerSubtitle: {
    fontSize: 13,
    flex: 1,
  },
  onlineIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
  },
  onlineText: {
    fontSize: 12,
    color: '#10B981',
    fontWeight: '500',
  },
  messagesList: {
    padding: 16,
    paddingBottom: 8,
  },
  messageContainer: {
    marginBottom: 4,
    maxWidth: '80%',
  },
  customerMessage: {
    alignSelf: 'flex-start',
  },
  agentMessage: {
    alignSelf: 'flex-end',
  },
  groupedMessage: {
    marginBottom: 2,
  },
  messageBubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
  },
  messageTime: {
    fontSize: 11,
    marginTop: 4,
  },
  internalLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  internalLabelText: {
    fontSize: 10,
    color: '#92400E',
    fontWeight: '500',
  },
  typingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  typingText: {
    fontSize: 13,
  },
  closedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
  },
  closedBannerText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  noteToggleContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    paddingTop: 8,
  },
  noteToggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  noteToggleActive: {
    backgroundColor: '#EFF6FF',
  },
  noteToggleActiveNote: {
    backgroundColor: '#FEF3C7',
  },
  noteToggleText: {
    fontSize: 12,
    fontWeight: '500',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 0.5,
    gap: 10,
  },
  internalToggle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
  },
  internalToggleActive: {
    backgroundColor: '#FEF3C7',
  },
  chatInputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 22,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: 44,
  },
  chatInput: {
    flex: 1,
    fontSize: 15,
    color: '#000000',
    maxHeight: 80,
    paddingVertical: 4,
  },
  chatSendButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  chatSendButtonActive: {
    backgroundColor: '#000000',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionsButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  actionsButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  closeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F3F4F6',
  },
  closeButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  actionSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 34,
  },
  actionSheetHandle: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  actionSheetHandleLine: {
    width: 36,
    height: 4,
    backgroundColor: '#D1D5DB',
    borderRadius: 2,
  },
  actionSheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 14,
  },
  actionSheetText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#000000',
  },
});
