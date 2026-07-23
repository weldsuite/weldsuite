import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Platform,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  ActivityIndicator,
  KeyboardAvoidingView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { ChevronLeft, EllipsisVertical, Image as ImageIcon, Zap, X, Clock, Forward, Archive, Trash2, Star, Ticket, ArrowUp, MessageSquare, Lock, Wifi, Plus, Mic, Camera, FileText, File, StickyNote } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useUser } from '@clerk/expo';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing, runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import api, { ConversationDetail, ConversationMessage as ApiConversationMessage, getApiErrorMessage } from '@/services/api';
import { useHelpdeskRealtime } from '@/hooks/useHelpdeskRealtime';
import { TypingIndicator, ConnectionBanner, ChatSkeleton } from '@/components/helpdesk';
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

export default function ConversationChatScreen() {
  const { id } = useLocalSearchParams();
  const { colors } = useTheme();
  const toast = useToast();
  const { user } = useUser();
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [showTicketSheet, setShowTicketSheet] = useState(false);
  const [showQuickActionsSheet, setShowQuickActionsSheet] = useState(false);
  const [showAttachmentSheet, setShowAttachmentSheet] = useState(false);
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketDescription, setTicketDescription] = useState('');
  const [ticketName, setTicketName] = useState('');
  const [ticketEmail, setTicketEmail] = useState('');
  const [ticketPriority, setTicketPriority] = useState('');
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; userId: string; name: string; email: string; role: string; availability: string }>>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Map<string, TypingIndicatorType>>(new Map());
  const [customerOnline, setCustomerOnline] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // Get agent info from Clerk user
  const agentId = user?.id || '';
  const agentName = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Agent';
  const agentEmail = user?.primaryEmailAddress?.emailAddress;
  const agentAvatar = user?.imageUrl;

  // Track recently sent message contents to deduplicate realtime echoes
  const recentSentMessagesRef = useRef<Set<string>>(new Set());

  // Handle incoming real-time message
  const handleRealtimeMessage = useCallback((message: RealtimeMessage) => {
    // Don't add if it's our own message (will be handled by optimistic update)
    if (message.senderId === agentId) return;

    // Deduplicate: skip if we recently sent this exact message content
    if (recentSentMessagesRef.current.has(message.content)) {
      recentSentMessagesRef.current.delete(message.content);
      return;
    }

    const newMessage: Message = {
      id: message.id || `msg-${Date.now()}`,
      text: message.content,
      sender: message.sender === 'customer' ? 'customer' : 'agent',
      senderName: message.senderName || 'Unknown',
      timestamp: message.timestamp,
      isRead: message.isRead ?? false,
      isInternal: false,
    };

    setMessages(prev => {
      // Final safety check: don't add if message with same text already exists
      if (prev.some(m => m.text === newMessage.text && m.id === newMessage.id)) return prev;
      return [...prev, newMessage];
    });

    // Scroll to bottom
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [agentId]);

  // Handle typing indicator
  const handleTyping = useCallback((indicator: TypingIndicatorType) => {
    // Only show customer typing (not our own)
    if (indicator.userType === 'customer') {
      if (indicator.isTyping) {
        setTypingUsers(prev => new Map(prev).set(indicator.userId, indicator));

        // Auto-remove after 3 seconds
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

  // Handle presence changes
  const handlePresenceChange = useCallback((member: PresenceMember, action: 'enter' | 'leave' | 'update') => {
    if (member.data?.type === 'customer') {
      setCustomerOnline(action !== 'leave');
    }
  }, []);

  // Initialize realtime connection
  const {
    isConnected,
    connectionState,
    sendMessage: sendRealtimeMessage,
    sendTypingIndicator,
    getPresenceMembers,
    connect: connectRealtime,
  } = useHelpdeskRealtime({
    conversationId: id as string,
    agentId,
    agentName,
    agentEmail,
    agentAvatar,
    onMessage: handleRealtimeMessage,
    onTyping: handleTyping,
    onPresenceChange: handlePresenceChange,
    autoConnect: !loading && !!id && !!agentId, // Only connect after initial load
  });

  // Check initial presence when connected
  useEffect(() => {
    if (isConnected) {
      getPresenceMembers().then(members => {
        setCustomerOnline(members.some(m => m.data?.type === 'customer'));
      });
    }
  }, [isConnected, getPresenceMembers]);

  const overlayOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(1000);
  const startY = useSharedValue(0);
  const ticketOverlayOpacity = useSharedValue(0);
  const ticketSheetTranslateY = useSharedValue(1000);
  const ticketStartY = useSharedValue(0);
  const quickActionsOverlayOpacity = useSharedValue(0);
  const quickActionsSheetTranslateY = useSharedValue(1000);
  const quickActionsStartY = useSharedValue(0);
  const attachmentOverlayOpacity = useSharedValue(0);
  const attachmentSheetTranslateY = useSharedValue(1000);
  const attachmentStartY = useSharedValue(0);

  useEffect(() => {
    if (showActionSheet) {
      overlayOpacity.value = withTiming(1, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      sheetTranslateY.value = withTiming(0, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    } else {
      overlayOpacity.value = withTiming(0, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      sheetTranslateY.value = withTiming(1000, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    }
  }, [showActionSheet]);

  useEffect(() => {
    if (showTicketSheet) {
      ticketOverlayOpacity.value = withTiming(1, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      ticketSheetTranslateY.value = withTiming(0, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    } else {
      ticketOverlayOpacity.value = withTiming(0, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      ticketSheetTranslateY.value = withTiming(1000, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    }
  }, [showTicketSheet]);

  useEffect(() => {
    if (showQuickActionsSheet) {
      quickActionsOverlayOpacity.value = withTiming(1, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      quickActionsSheetTranslateY.value = withTiming(0, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    } else {
      quickActionsOverlayOpacity.value = withTiming(0, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      quickActionsSheetTranslateY.value = withTiming(1000, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    }
  }, [showQuickActionsSheet]);

  useEffect(() => {
    if (showAttachmentSheet) {
      attachmentOverlayOpacity.value = withTiming(1, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      attachmentSheetTranslateY.value = withTiming(0, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    } else {
      attachmentOverlayOpacity.value = withTiming(0, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      attachmentSheetTranslateY.value = withTiming(1000, {
        duration: 250,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    }
  }, [showAttachmentSheet]);

  useEffect(() => {
    loadConversationData();
  }, [id]);

  const loadConversationData = async () => {
    if (!id) return;

    try {
      setLoading(true);
      // First get the conversation details
      const conversationResponse = await api.getConversation(id as string);

      if (conversationResponse.success && conversationResponse.data) {
        setConversation(conversationResponse.data);

        // Mark conversation as read
        api.markConversationAsRead(id as string).catch(() => {});

        // Then get the messages
        const messagesResponse = await api.getConversationMessages(id as string);

        if (messagesResponse.success && messagesResponse.data) {
          // mobile-api-worker returns paginated response with items array
          const messageList = messagesResponse.data.items || [];

          // Convert API messages to local Message format
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

  // Handle input text change with typing indicator
  const handleInputChange = (text: string) => {
    setInputText(text);

    // Send typing indicator for non-internal messages
    if (!isInternalNote && text.length > 0) {
      sendTypingIndicator(true);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !id || sending) return;

    const messageText = inputText.trim();
    const wasInternalNote = isInternalNote;
    setInputText('');
    setSending(true);

    // Stop typing indicator
    sendTypingIndicator(false);

    // Add optimistic message immediately for better UX
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

    // Scroll to bottom immediately
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      // Send via API for persistence
      const response = await api.sendConversationMessage(id as string, messageText, wasInternalNote);

      if (response.success && response.data) {
        // Replace optimistic message with real message from server
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

        // Also send via realtime (only for non-internal messages)
        if (!wasInternalNote && isConnected) {
          try {
            // Track sent content to deduplicate the realtime echo
            recentSentMessagesRef.current.add(messageText);
            // Auto-cleanup after 10 seconds to prevent memory leaks
            setTimeout(() => {
              recentSentMessagesRef.current.delete(messageText);
            }, 10000);
            await sendRealtimeMessage(messageText);
          } catch (rtError) {
            recentSentMessagesRef.current.delete(messageText);
            console.warn('Failed to send via realtime (message was still saved):', rtError);
          }
        }
      } else {
        // Remove optimistic message and restore input on error
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        toast.error(getApiErrorMessage(response.error, 'Failed to send message'));
        setInputText(messageText);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      // Remove optimistic message and restore input on error
      setMessages(prev => prev.filter(msg => msg.id !== tempId));
      toast.error('Failed to send message');
      setInputText(messageText);
    } finally {
      setSending(false);
    }
  };

  const pickImage = async () => {
    try {
      // Check current permission status first
      const { status: existingStatus } = await ImagePicker.getMediaLibraryPermissionsAsync();

      let finalStatus = existingStatus;

      // If not determined, request permission
      if (existingStatus !== 'granted') {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        toast.error('Please enable photo library access in Settings to select images.');
        return;
      }

      // Launch image picker
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        toast.success(`Image selected: ${asset.fileName || 'image.jpg'}`);
        // TODO: Upload image and attach to message
      }
    } catch (error) {
      console.error('Error picking image:', error);
      toast.error('Failed to pick image');
    }
  };

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    const isCustomer = item.sender === 'customer';
    const prevMessage = index > 0 ? messages[index - 1] : null;
    const nextMessage = index < messages.length - 1 ? messages[index + 1] : null;

    // Check if this message is part of a group (same sender within 5 minutes)
    const isGroupedWithPrev = prevMessage &&
      prevMessage.sender === item.sender &&
      (new Date(item.timestamp).getTime() - new Date(prevMessage.timestamp).getTime()) < 5 * 60 * 1000;

    const isGroupedWithNext = nextMessage &&
      nextMessage.sender === item.sender &&
      (new Date(nextMessage.timestamp).getTime() - new Date(item.timestamp).getTime()) < 5 * 60 * 1000;

    // Determine which corners should be less rounded
    const getBubbleStyle = () => {
      if (isCustomer) {
        // Customer messages (left side)
        if (isGroupedWithPrev && isGroupedWithNext) {
          // Middle message
          return styles.customerBubbleMiddle;
        } else if (isGroupedWithPrev) {
          // Last message in group
          return styles.customerBubbleLast;
        } else {
          // First message in group or single message - fully rounded
          return styles.customerBubble;
        }
      } else {
        // Agent messages (right side)
        if (isGroupedWithPrev && isGroupedWithNext) {
          // Middle message
          return styles.agentBubbleMiddle;
        } else if (isGroupedWithPrev) {
          // Last message in group
          return styles.agentBubbleLast;
        } else {
          // First message in group or single message - fully rounded
          return styles.agentBubble;
        }
      }
    };

    // Internal notes have a different style
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
          getBubbleStyle(),
          {
            backgroundColor: bubbleColor,
            borderWidth: isInternal ? 1 : 0,
            borderColor: isInternal ? '#FCD34D' : 'transparent',
          }
        ]}>
          <Text style={[
            styles.messageText,
            { color: textColor }
          ]}>
            {item.text}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={[
              styles.messageTime,
              { color: timeColor }
            ]}>
              {formatTime(item.timestamp)}
            </Text>
            {!isCustomer && !isInternal && (
              <Text style={[
                styles.messageTime,
                { color: '#E0E7FF' }
              ]}>
                • {item.isRead ? 'Read' : 'Unread'}
              </Text>
            )}
          </View>
        </View>
      </View>
    );
  };

  const animatedOverlayStyle = useAnimatedStyle(() => {
    return {
      opacity: overlayOpacity.value,
    };
  });

  const animatedSheetStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: sheetTranslateY.value }],
    };
  });

  const animatedTicketOverlayStyle = useAnimatedStyle(() => {
    return {
      opacity: ticketOverlayOpacity.value,
    };
  });

  const animatedTicketSheetStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: ticketSheetTranslateY.value }],
    };
  });

  const animatedQuickActionsOverlayStyle = useAnimatedStyle(() => {
    return {
      opacity: quickActionsOverlayOpacity.value,
    };
  });

  const animatedQuickActionsSheetStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: quickActionsSheetTranslateY.value }],
    };
  });

  const animatedAttachmentOverlayStyle = useAnimatedStyle(() => {
    return {
      opacity: attachmentOverlayOpacity.value,
    };
  });

  const animatedAttachmentSheetStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: attachmentSheetTranslateY.value }],
    };
  });

  const panGesture = Gesture.Pan()
    .enableTrackpadTwoFingerGesture(true)
    .activeOffsetY(10)
    .failOffsetY(-10)
    .onBegin(() => {
      startY.value = sheetTranslateY.value;
    })
    .onUpdate((event) => {
      const newValue = startY.value + event.translationY;
      if (newValue >= 0) {
        sheetTranslateY.value = newValue;
      }
    })
    .onEnd((event) => {
      if (event.translationY > 100 || event.velocityY > 500) {
        // Swipe down threshold - dismiss
        sheetTranslateY.value = withTiming(1000, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        overlayOpacity.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        runOnJS(setShowActionSheet)(false);
      } else {
        // Snap back to open position
        sheetTranslateY.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
      }
    });

  const ticketPanGesture = Gesture.Pan()
    .enableTrackpadTwoFingerGesture(true)
    .activeOffsetY(10)
    .failOffsetY(-10)
    .onBegin(() => {
      ticketStartY.value = ticketSheetTranslateY.value;
    })
    .onUpdate((event) => {
      const newValue = ticketStartY.value + event.translationY;
      if (newValue >= 0) {
        ticketSheetTranslateY.value = newValue;
      }
    })
    .onEnd((event) => {
      if (event.translationY > 100 || event.velocityY > 500) {
        // Swipe down threshold - dismiss
        ticketSheetTranslateY.value = withTiming(1000, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        ticketOverlayOpacity.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        runOnJS(setShowTicketSheet)(false);
      } else {
        // Snap back to open position
        ticketSheetTranslateY.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
      }
    });

  const quickActionsPanGesture = Gesture.Pan()
    .enableTrackpadTwoFingerGesture(true)
    .activeOffsetY(10)
    .failOffsetY(-10)
    .onBegin(() => {
      quickActionsStartY.value = quickActionsSheetTranslateY.value;
    })
    .onUpdate((event) => {
      const newValue = quickActionsStartY.value + event.translationY;
      if (newValue >= 0) {
        quickActionsSheetTranslateY.value = newValue;
      }
    })
    .onEnd((event) => {
      if (event.translationY > 100 || event.velocityY > 500) {
        // Swipe down threshold - dismiss
        quickActionsSheetTranslateY.value = withTiming(1000, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        quickActionsOverlayOpacity.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        runOnJS(setShowQuickActionsSheet)(false);
      } else {
        // Snap back to open position
        quickActionsSheetTranslateY.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
      }
    });

  const attachmentPanGesture = Gesture.Pan()
    .enableTrackpadTwoFingerGesture(true)
    .activeOffsetY(10)
    .failOffsetY(-10)
    .onBegin(() => {
      attachmentStartY.value = attachmentSheetTranslateY.value;
    })
    .onUpdate((event) => {
      const newValue = attachmentStartY.value + event.translationY;
      if (newValue >= 0) {
        attachmentSheetTranslateY.value = newValue;
      }
    })
    .onEnd((event) => {
      if (event.translationY > 100 || event.velocityY > 500) {
        attachmentSheetTranslateY.value = withTiming(1000, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        attachmentOverlayOpacity.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
        runOnJS(setShowAttachmentSheet)(false);
      } else {
        attachmentSheetTranslateY.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        });
      }
    });

  const takePhoto = async () => {
    setShowAttachmentSheet(false);
    setTimeout(async () => {
      try {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
          toast.error('Sorry, we need camera permissions to take photos.');
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          quality: 0.8,
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          toast.success(`Photo captured: ${asset.fileName || 'photo.jpg'}`);
          // TODO: Upload the photo and attach to message
        }
      } catch (error) {
        console.error('Error taking photo:', error);
        toast.error('Failed to take photo');
      }
    }, 300);
  };

  const pickDocument = async () => {
    setShowAttachmentSheet(false);
    setTimeout(async () => {
      try {
        const result = await DocumentPicker.getDocumentAsync({
          type: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
          copyToCacheDirectory: true,
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          toast.success(`Document selected: ${asset.name}`);
          // TODO: Upload the document and attach to message
        }
      } catch (error) {
        console.error('Error picking document:', error);
        toast.error('Failed to pick document');
      }
    }, 300);
  };

  const pickFile = async () => {
    setShowAttachmentSheet(false);
    setTimeout(async () => {
      try {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          copyToCacheDirectory: true,
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          toast.success(`File selected: ${asset.name}`);
          // TODO: Upload the file and attach to message
        }
      } catch (error) {
        console.error('Error picking file:', error);
        toast.error('Failed to pick file');
      }
    }, 300);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? -24 : 0}
      >
        {/* Messages List */}
        <View style={{ flex: 1 }}>
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messagesList}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              conversation?.assigneeId && conversation.assigneeId === agentId ? (
                <View style={styles.assignedBanner}>
                  <Text style={styles.assignedBannerText}>This conversation is assigned to you</Text>
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 }}>
                <Text style={{ color: colors.muted, fontSize: 14 }}>No messages yet</Text>
              </View>
            }
          />
        </View>

        {/* Connection Banner */}
        <ConnectionBanner state={connectionState} onRetry={connectRealtime} />

        {/* Typing Indicator */}
        {typingUsers.size > 0 && (
          <TypingIndicator users={Array.from(typingUsers.values())} />
        )}

        {conversation?.status === 'closed' || conversation?.status === 'resolved' ? (
          <View style={{ backgroundColor: '#F9FAFB', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E7EB', paddingBottom: Platform.OS === 'ios' ? 34 : 12 }}>
            <View style={styles.closedBanner}>
              <Lock size={14} color="#6B7280" />
              <Text style={styles.closedBannerText}>
                This conversation has been {conversation.status === 'resolved' ? 'resolved' : 'closed'}
              </Text>
            </View>
          </View>
        ) : (
          <>
            {/* Input Area */}
            <View style={{ backgroundColor: colors.background, paddingBottom: Platform.OS === 'ios' ? 34 : 12 }}>
              <View style={styles.commentInputContainer}>
                <View style={[styles.commentInputBox, { borderColor: isInternalNote ? '#FDE68A' : colors.border, backgroundColor: isInternalNote ? '#FFFBEB' : 'transparent' }]}>
                  <TextInput
                    style={styles.commentInput}
                    placeholder={isInternalNote ? "Write an internal note..." : "Write a comment..."}
                    placeholderTextColor="#9CA3AF"
                    value={inputText}
                    onChangeText={handleInputChange}
                    multiline
                    maxLength={1000}
                  />
                  <View style={styles.commentInputActions}>
                    <View style={styles.commentActionsLeft}>
                      <TouchableOpacity
                        style={styles.commentActionButton}
                        onPress={() => setShowAttachmentSheet(true)}
                      >
                        <Plus size={20} color="#9CA3AF" strokeWidth={2} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.commentActionButton}
                        onPress={() => setIsInternalNote(!isInternalNote)}
                      >
                        <StickyNote size={18} color={isInternalNote ? '#F59E0B' : '#9CA3AF'} strokeWidth={2} />
                      </TouchableOpacity>
                    </View>
                    <View style={styles.commentActionsRight}>
                      <TouchableOpacity style={styles.commentActionButton}>
                        <Svg width={20} height={14} viewBox="0 0 889.29 618.69">
                          <Path d="M759.79,0v129.48H129.48v359.69c-29.88-8.21-56.62-24.07-77.92-45.32C19.72,411.96,0,367.95,0,319.32v-143.22C0,78.84,78.84,0,176.1,0h583.7Z" fill="#9CA3AF" />
                          <Path d="M129.49,618.69v-129.48h630.32V129.51c29.88,8.21,56.62,24.07,77.92,45.32,31.84,31.89,51.56,75.9,51.56,124.53v143.22c0,97.26-78.84,176.1-176.1,176.1H129.49Z" fill="#9CA3AF" />
                          <Path d="M419.29,349.82h-161.9c0-44.73,36.22-80.95,80.95-80.95s80.95,36.22,80.95,80.95Z" fill="#9CA3AF" />
                          <Path d="M631.9,349.82h-161.9c0-44.73,36.22-80.95,80.95-80.95s80.95,36.22,80.95,80.95Z" fill="#9CA3AF" />
                        </Svg>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.commentSendButton,
                          inputText.trim() ? styles.commentSendButtonActive : {},
                          sending && { opacity: 0.6 },
                        ]}
                        onPress={handleSend}
                        disabled={sending || !inputText.trim()}
                      >
                        {sending ? (
                          <ActivityIndicator size="small" color={inputText.trim() ? '#FFFFFF' : '#9CA3AF'} />
                        ) : (
                          <ArrowUp size={16} color={inputText.trim() ? '#FFFFFF' : '#9CA3AF'} strokeWidth={2.5} />
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          </>
        )}
      </KeyboardAvoidingView>

      {/* Header - Fixed on top with elevated z-index */}
      <SafeAreaView edges={['top']} style={[styles.headerContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: '#F3F4F6' }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerInfo}
            onPress={() => {
              const contactIdToUse = conversation?.contactId || conversation?.customerId;
              if (contactIdToUse) {
                router.push(`/helpdesk/contact/${contactIdToUse}` as any);
              }
            }}
          >
            <Text style={[styles.headerTitle, { color: colors.text }]}>{conversation?.contactName || conversation?.customerName || 'Unknown'}</Text>
            <Text style={[styles.headerSubtitle, { color: colors.muted }]} numberOfLines={1}>{conversation?.subject || 'Loading...'}</Text>
          </TouchableOpacity>
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
                if (!conversation || !id || closing) return;
                setClosing(true);
                try {
                  const response = await api.closeConversation(id as string);
                  if (response.success) {
                    toast.success('Conversation closed');
                    router.back();
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
                <Text style={styles.closeButtonText}>Close</Text>
              )}
            </TouchableOpacity>
            )}
          </View>
        </View>
      </SafeAreaView>

      {/* Bottom Action Sheet */}
      <Modal
        visible={showActionSheet}
        transparent={true}
        animationType="none"
        onRequestClose={() => setShowActionSheet(false)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Animated.View style={[styles.modalOverlay, animatedOverlayStyle]}>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => setShowActionSheet(false)}
            />
            <GestureDetector gesture={panGesture}>
              <Animated.View style={[styles.actionSheetContainer, animatedSheetStyle]}>
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
                    const response = await api.snoozeConversation(id as string, snoozedUntil);
                    if (response.success) {
                      toast.success('Conversation snoozed for 1 hour');
                      router.back();
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
                      ? await api.unstarConversation(id as string)
                      : await api.starConversation(id as string);
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
                      setAgents(result.data.filter(a => a.userId !== agentId));
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
                    const response = await api.archiveConversation(id as string);
                    if (response.success) {
                      toast.success('Conversation archived');
                      router.back();
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
                  setShowTicketSheet(true);
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
                            const response = await api.updateConversationStatus(id as string, 'closed');
                            if (response.success) {
                              toast.success('Conversation deleted');
                              router.back();
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
              </Animated.View>
            </GestureDetector>
        </Animated.View>
        </GestureHandlerRootView>
      </Modal>

      {/* Ticket Bottom Sheet */}
      <Modal
        visible={showTicketSheet}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowTicketSheet(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          {/* Modal Header */}
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingVertical: 12,
            paddingTop: 16,
            backgroundColor: colors.background,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
          }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text, marginLeft: 16 }}>Create Ticket</Text>
            <View style={{ marginRight: 16 }}>
              <TouchableOpacity
                onPress={() => setShowTicketSheet(false)}
                style={{ padding: 4 }}
              >
                <X size={20} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Modal Content */}
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            <View style={{ paddingHorizontal: 20, paddingVertical: 20 }}>
                      <View style={{ gap: 16 }}>
                        {/* Name */}
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Name</Text>
                          <TextInput
                            style={{
                              backgroundColor: '#FFFFFF',
                              borderWidth: 1,
                              borderColor: '#E5E7EB',
                              borderRadius: 8,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 15,
                              color: '#000000',
                            }}
                            placeholder="Enter name"
                            placeholderTextColor="#9CA3AF"
                            value={ticketName}
                            onChangeText={setTicketName}
                          />
                        </View>

                        {/* Email */}
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Email</Text>
                          <TextInput
                            style={{
                              backgroundColor: '#FFFFFF',
                              borderWidth: 1,
                              borderColor: '#E5E7EB',
                              borderRadius: 8,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 15,
                              color: '#000000',
                            }}
                            placeholder="Enter email"
                            placeholderTextColor="#9CA3AF"
                            value={ticketEmail}
                            onChangeText={setTicketEmail}
                            keyboardType="email-address"
                          />
                        </View>

                        {/* Subject */}
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Subject *</Text>
                          <TextInput
                            style={{
                              backgroundColor: '#FFFFFF',
                              borderWidth: 1,
                              borderColor: '#E5E7EB',
                              borderRadius: 8,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 15,
                              color: '#000000',
                            }}
                            placeholder="Enter subject"
                            placeholderTextColor="#9CA3AF"
                            value={ticketSubject}
                            onChangeText={setTicketSubject}
                          />
                        </View>

                        {/* Description */}
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Description</Text>
                          <TextInput
                            style={{
                              backgroundColor: '#FFFFFF',
                              borderWidth: 1,
                              borderColor: '#E5E7EB',
                              borderRadius: 8,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 15,
                              color: '#000000',
                              minHeight: 80,
                              textAlignVertical: 'top',
                            }}
                            placeholder="Enter description"
                            placeholderTextColor="#9CA3AF"
                            value={ticketDescription}
                            onChangeText={setTicketDescription}
                            multiline
                          />
                        </View>

                        {/* Category */}
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Category</Text>
                          <TextInput
                            style={{
                              backgroundColor: '#FFFFFF',
                              borderWidth: 1,
                              borderColor: '#E5E7EB',
                              borderRadius: 8,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 15,
                              color: '#000000',
                            }}
                            placeholder="Select category"
                            placeholderTextColor="#9CA3AF"
                          />
                        </View>

                        {/* Priority */}
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Priority</Text>
                          <TextInput
                            style={{
                              backgroundColor: '#FFFFFF',
                              borderWidth: 1,
                              borderColor: '#E5E7EB',
                              borderRadius: 8,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 15,
                              color: '#000000',
                            }}
                            placeholder="normal, high, urgent, low"
                            placeholderTextColor="#9CA3AF"
                            value={ticketPriority}
                            onChangeText={setTicketPriority}
                          />
                        </View>

                        {/* Assign to Team and Person */}
                        <View style={{ flexDirection: 'row', gap: 12 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Assign to Team</Text>
                            <TextInput
                              style={{
                                backgroundColor: '#FFFFFF',
                                borderWidth: 1,
                                borderColor: '#E5E7EB',
                                borderRadius: 8,
                                paddingHorizontal: 12,
                                paddingVertical: 10,
                                fontSize: 15,
                                color: '#000000',
                              }}
                              placeholder="Select team"
                              placeholderTextColor="#9CA3AF"
                            />
                          </View>

                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, fontWeight: '500', marginBottom: 6, color: '#374151' }}>Assign to Person</Text>
                            <TextInput
                              style={{
                                backgroundColor: '#FFFFFF',
                                borderWidth: 1,
                                borderColor: '#E5E7EB',
                                borderRadius: 8,
                                paddingHorizontal: 12,
                                paddingVertical: 10,
                                fontSize: 15,
                                color: '#000000',
                              }}
                              placeholder="Select person"
                              placeholderTextColor="#9CA3AF"
                            />
                          </View>
                        </View>
                      </View>
            </View>
          </ScrollView>

          {/* Create Ticket Button */}
          <View style={{ paddingHorizontal: 20, paddingVertical: 16, backgroundColor: colors.background }}>
            <TouchableOpacity
              style={{
                backgroundColor: '#000000',
                borderRadius: 8,
                paddingVertical: 14,
                alignItems: 'center',
                opacity: creatingTicket ? 0.6 : 1,
              }}
              disabled={creatingTicket}
              onPress={async () => {
                if (!ticketSubject.trim()) {
                  toast.error('Please enter a subject');
                  return;
                }
                setCreatingTicket(true);
                try {
                  const response = await api.createTicket({
                    subject: ticketSubject.trim(),
                    description: ticketDescription.trim() || undefined,
                    priority: ticketPriority.trim() || undefined,
                    contactName: ticketName.trim() || undefined,
                    contactEmail: ticketEmail.trim() || undefined,
                  });
                  if (response.success && response.data) {
                    toast.success('Ticket created');
                    setShowTicketSheet(false);
                    setTicketSubject('');
                    setTicketDescription('');
                    setTicketName('');
                    setTicketEmail('');
                    setTicketPriority('');
                  } else {
                    toast.error(getApiErrorMessage(response.error, 'Failed to create ticket'));
                  }
                } catch (error) {
                  toast.error('Failed to create ticket');
                } finally {
                  setCreatingTicket(false);
                }
              }}
            >
              {creatingTicket ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>Create Ticket</Text>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* Quick Actions Bottom Sheet */}
      <Modal
        visible={showQuickActionsSheet}
        transparent={true}
        animationType="none"
        onRequestClose={() => setShowQuickActionsSheet(false)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Animated.View style={[styles.modalOverlay, animatedQuickActionsOverlayStyle]}>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => setShowQuickActionsSheet(false)}
            />
            <GestureDetector gesture={quickActionsPanGesture}>
              <Animated.View style={[styles.actionSheetContainer, animatedQuickActionsSheetStyle]}>
                <View style={styles.actionSheet}>
                  <View style={styles.actionSheetHandle}>
                    <View style={styles.actionSheetHandleLine} />
                  </View>

                  <TouchableOpacity
                    style={styles.actionSheetItem}
                    onPress={() => {
                      setShowQuickActionsSheet(false);
                      // Handle send form action
                    }}
                  >
                    <ImageIcon size={20} color="#000000" />
                    <Text style={styles.actionSheetText}>Send Form</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.actionSheetItem}
                    onPress={() => {
                      setShowQuickActionsSheet(false);
                      // Handle track parcel action
                    }}
                  >
                    <Zap size={20} color="#000000" />
                    <Text style={styles.actionSheetText}>Track Parcel</Text>
                  </TouchableOpacity>

                </View>
              </Animated.View>
            </GestureDetector>
        </Animated.View>
        </GestureHandlerRootView>
      </Modal>

      {/* Attachment Options Bottom Sheet */}
      <Modal
        visible={showAttachmentSheet}
        transparent={true}
        animationType="none"
        onRequestClose={() => setShowAttachmentSheet(false)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Animated.View style={[styles.modalOverlay, animatedAttachmentOverlayStyle]}>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => setShowAttachmentSheet(false)}
            />
            <GestureDetector gesture={attachmentPanGesture}>
              <Animated.View style={[styles.actionSheetContainer, animatedAttachmentSheetStyle]}>
                <View style={styles.actionSheet}>
                  <View style={styles.actionSheetHandle}>
                    <View style={styles.actionSheetHandleLine} />
                  </View>

                  <TouchableOpacity
                    style={styles.actionSheetItem}
                    onPress={takePhoto}
                  >
                    <Camera size={20} color="#000000" />
                    <Text style={styles.actionSheetText}>Take Photo</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.actionSheetItem}
                    onPress={() => {
                      setShowAttachmentSheet(false);
                      setTimeout(() => pickImage(), 300);
                    }}
                  >
                    <ImageIcon size={20} color="#000000" />
                    <Text style={styles.actionSheetText}>Choose from Library</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.actionSheetItem}
                    onPress={pickDocument}
                  >
                    <FileText size={20} color="#000000" />
                    <Text style={styles.actionSheetText}>Upload Document</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.actionSheetItem}
                    onPress={pickFile}
                  >
                    <File size={20} color="#000000" />
                    <Text style={styles.actionSheetText}>Upload File</Text>
                  </TouchableOpacity>

                </View>
              </Animated.View>
            </GestureDetector>
          </Animated.View>
        </GestureHandlerRootView>
      </Modal>

      {/* Transfer Modal */}
      <Modal
        visible={showTransferModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowTransferModal(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingTop: 16, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text, marginLeft: 16 }}>Transfer Conversation</Text>
            <TouchableOpacity onPress={() => setShowTransferModal(false)} style={{ padding: 4, marginRight: 16 }}>
              <X size={20} color={colors.text} strokeWidth={2} />
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
                      const response = await api.assignConversation(id as string, agent.userId, agent.name);
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
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 4,
    marginRight: 8,
  },
  headerInfo: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerSubtitle: {
    fontSize: 13,
    marginTop: 0,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  moreButton: {
    padding: 4,
  },
  actionsButton: {
    paddingHorizontal: 12,
    paddingVertical: 7,
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
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#000000',
  },
  closeButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  assignedBanner: {
    alignSelf: 'center',
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 9,
    marginBottom: 12,
  },
  assignedBannerText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1F2937',
  },
  messagesList: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    paddingTop: 120,
  },
  messageContainer: {
    marginBottom: 12,
    maxWidth: '75%',
  },
  groupedMessage: {
    marginBottom: 2,
  },
  customerMessage: {
    alignSelf: 'flex-start',
  },
  agentMessage: {
    alignSelf: 'flex-end',
  },
  internalLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  internalLabelText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#92400E',
  },
  messageBubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  customerBubble: {
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  customerBubbleLast: {
    borderRadius: 16,
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
  },
  customerBubbleMiddle: {
    borderRadius: 16,
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
  },
  agentBubble: {
    borderRadius: 16,
    borderBottomRightRadius: 4,
  },
  agentBubbleLast: {
    borderRadius: 16,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  agentBubbleMiddle: {
    borderRadius: 16,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
  },
  messageTime: {
    fontSize: 11,
    marginTop: 4,
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
    paddingHorizontal: 12,
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
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  inputWrapper: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    minHeight: 90,
    position: 'relative',
  },
  input: {
    fontSize: 15,
    lineHeight: 20,
    minHeight: 40,
    maxHeight: 200,
  },
  actionButtons: {
    position: 'absolute',
    bottom: 10,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  actionButton: {
    padding: 4,
  },
  sendButton: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    backgroundColor: '#000000',
    borderRadius: 10,
    width: 31,
    height: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  actionSheetContainer: {
    width: '100%',
  },
  actionSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    overflow: 'hidden',
  },
  actionSheetHandle: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  actionSheetHandleLine: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D1D5DB',
  },
  actionSheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 14,
  },
  actionSheetText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#000000',
  },
  // ChatGPT-style input
  commentInputContainer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  commentInputBox: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 8,
    minHeight: 100,
  },
  commentInput: {
    flex: 1,
    fontSize: 15,
    color: '#000000',
    maxHeight: 100,
    paddingVertical: 0,
    marginLeft: 3,
    marginTop: 2,
  },
  commentInputActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  commentActionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commentActionButton: {
    padding: 2,
  },
  commentActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  commentSendButton: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentSendButtonActive: {
    backgroundColor: '#000000',
  },
});
