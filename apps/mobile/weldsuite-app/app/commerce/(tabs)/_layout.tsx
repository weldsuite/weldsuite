import { Tabs } from "expo-router";
import React, { useState, useEffect, useRef } from "react";
import { Home, Package, ShoppingCart, ChevronLeft, BarChart, X, ArrowUp, ImageIcon as Image, Zap, MessageSquarePlus, History, Users } from 'lucide-react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, Modal, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, Easing, Keyboard, LayoutAnimation, UIManager, SafeAreaView, StatusBar, FlatList, Alert } from 'react-native';
import { router } from 'expo-router';
import WeldAgentLogo from '@/components/WeldAgentLogo';

// Enable LayoutAnimation on Android (only needed for old architecture)
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental &&
  !(global as any).__turboModuleProxy
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface AgentMessage {
  id: string;
  text: string;
  sender: 'user' | 'agent';
  timestamp: string;
}

export default function CommerceTabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [agentModalVisible, setAgentModalVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const flatListRef = useRef<FlatList>(null);

  const handleSend = () => {
    if (message.trim()) {
      const newMessage: AgentMessage = {
        id: Date.now().toString(),
        text: message.trim(),
        sender: 'user',
        timestamp: new Date().toISOString(),
      };
      setMessages([...messages, newMessage]);
      setMessage('');

      // Scroll to bottom after sending
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  };

  const renderMessage = ({ item, index }: { item: AgentMessage; index: number }) => {
    const isUser = item.sender === 'user';
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
      if (isUser) {
        // User messages (right side)
        if (isGroupedWithPrev && isGroupedWithNext) {
          return styles.agentBubbleMiddle;
        } else if (isGroupedWithPrev) {
          return styles.agentBubbleLast;
        } else {
          return styles.agentBubble;
        }
      } else {
        // Agent messages (left side)
        if (isGroupedWithPrev && isGroupedWithNext) {
          return styles.customerBubbleMiddle;
        } else if (isGroupedWithPrev) {
          return styles.customerBubbleLast;
        } else {
          return styles.customerBubble;
        }
      }
    };

    return (
      <View style={[
        styles.messageContainer,
        isUser ? styles.agentMessage : styles.customerMessage,
        isGroupedWithNext && styles.groupedMessage,
      ]}>
        <View style={[
          styles.messageBubble,
          getBubbleStyle(),
          {
            backgroundColor: isUser ? '#3B82F6' : '#F3F4F6',
          }
        ]}>
          <Text style={[
            styles.messageText,
            { color: isUser ? '#FFFFFF' : colors.text }
          ]}>
            {item.text}
          </Text>
          <Text style={[
            styles.messageTime,
            { color: isUser ? '#E0E7FF' : colors.muted }
          ]}>
            {formatTime(item.timestamp)}
          </Text>
        </View>
      </View>
    );
  };

  const HeaderLeft = () => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TouchableOpacity
        onPress={() => router.replace('/(tabs)')}
        style={styles.homeButton}
      >
        <Home size={18} color="#374151" strokeWidth={2} />
        <Text style={styles.homeButtonText}>Home</Text>
      </TouchableOpacity>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            backgroundColor: '#000000',
            borderRadius: 8,
            width: 36,
            height: 36,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Package size={20} color="#FFFFFF" strokeWidth={2} />
        </View>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>Commerce</Text>
      </View>
    </View>
  );

  // AI (WeldAgent) has been removed along with the AI backend — the button
  // now surfaces an unavailable notice instead of opening the agent overlay.
  const HeaderRight = () => (
    <TouchableOpacity
      style={{ marginRight: 16 }}
      onPress={() => Alert.alert('AI unavailable', 'AI is currently unavailable.')}
    >
      <WeldAgentLogo size={20} color="#000000" />
    </TouchableOpacity>
  );

  return (
    <>
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        headerShown: true,
        headerStyle: {
          backgroundColor: colors.background,
          borderBottomWidth: 0.5,
          borderBottomColor: '#E5E7EB',
          height: 100,
        },
        headerShadowVisible: false,
        headerTintColor: colors.text,
        headerLeft: HeaderLeft,
        headerRight: HeaderRight,
        headerTitle: '',
        headerLeftContainerStyle: {
          paddingLeft: 16,
        },
        tabBarStyle: {
          backgroundColor: colors.cardBackground,
          height: 50 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
          marginTop: 2,
        },
        tabBarIconStyle: {
          marginBottom: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => (
            <Home size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="products"
        options={{
          title: "Products",
          tabBarIcon: ({ color, size }) => (
            <Package size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="orders"
        options={{
          title: "Orders",
          tabBarIcon: ({ color, size }) => (
            <ShoppingCart size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="customers"
        options={{
          title: "Customers",
          tabBarIcon: ({ color, size }) => (
            <Users size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="inventory"
        options={{
          title: "Inventory",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="cube-outline" size={20} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="analytics"
        options={{
          title: "Analytics",
          tabBarIcon: ({ color, size }) => (
            <BarChart size={20} color={color} strokeWidth={2} />
          ),
        }}
      />
    </Tabs>

    {/* WeldAgent Overlay */}
    <Modal
      animationType="slide"
      visible={agentModalVisible}
      onRequestClose={() => setAgentModalVisible(false)}
      presentationStyle="formSheet"
    >
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        {/* Agent Header */}
        <View style={[styles.agentHeader, { backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.divider }]}>
          <Text style={[styles.conversationTitle, { color: colors.text, marginLeft: 16 }]}>New conversation</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginRight: 16 }}>
            <TouchableOpacity style={styles.headerButton}>
              <MessageSquarePlus size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.headerButton}>
              <History size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setAgentModalVisible(false)}
              style={styles.headerButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
          keyboardVerticalOffset={0}
        >

              {/* Messages List */}
              <FlatList
                ref={flatListRef}
                data={messages}
                renderItem={renderMessage}
                keyExtractor={(item) => item.id}
                style={{ flex: 1, backgroundColor: colors.background }}
                contentContainerStyle={styles.messagesList}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
              />

              {/* Input Bar */}
              <SafeAreaView edges={['bottom']} style={{ backgroundColor: colors.background }}>
                <View style={[styles.inputContainer, { backgroundColor: colors.background }]}>
                  <View style={[styles.inputWrapper, { backgroundColor: '#F3F4F6' }]}>
                    <TextInput
                      style={[styles.input, { color: colors.text }]}
                      placeholder="Type a message..."
                      placeholderTextColor={colors.muted}
                      value={message}
                      onChangeText={setMessage}
                      multiline
                      maxLength={1000}
                      textAlignVertical="top"
                    />

                    {/* Left Action Buttons */}
                    <View style={styles.actionButtons}>
                      <TouchableOpacity
                        style={styles.actionButton}
                      >
                        <Image size={20} color={colors.muted} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.actionButton}
                      >
                        <Zap size={20} color={colors.muted} />
                      </TouchableOpacity>
                    </View>

                    {/* Send Button - Right Side */}
                    <TouchableOpacity
                      style={styles.sendButton}
                      disabled={!message.trim()}
                      onPress={handleSend}
                    >
                      <ArrowUp size={20} color="#FFFFFF" strokeWidth={2.5} />
                    </TouchableOpacity>
                  </View>
                </View>
              </SafeAreaView>
          </KeyboardAvoidingView>
        </SafeAreaView>
    </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  homeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 6,
  },
  homeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  modalStack: {
    flex: 1,
    backgroundColor: '#1C1C1E',
  },
  previousPageContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 25,
    paddingHorizontal: 12,
  },
  previousPage: {
    height: '100%',
    borderRadius: 12,
    transform: [{ scale: 0.95 }],
    opacity: 0.5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  previousPageHeader: {
    alignItems: 'center',
    paddingTop: 10,
  },
  previousPageNotch: {
    width: 36,
    height: 4,
    backgroundColor: '#8E8E93',
    borderRadius: 100,
  },
  agentContainer: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 10,
    backgroundColor: '#FFFFFF',
  },
  agentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
  },
  conversationTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  headerButton: {
    padding: 4,
  },
  welcomeSection: {
    alignItems: 'center',
    marginBottom: 40,
    marginTop: 40,
  },
  agentAvatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  heyThere: {
    fontSize: 32,
    fontWeight: '600',
    marginBottom: 4,
  },
  howCanIHelp: {
    fontSize: 24,
    fontWeight: '500',
    marginBottom: 24,
  },
  whatsNewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  bulletPoint: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#7C3AED',
  },
  whatsNewText: {
    fontSize: 16,
  },
  suggestionPills: {
    paddingHorizontal: 20,
    gap: 12,
  },
  suggestionPill: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 24,
    borderWidth: 1,
    marginBottom: 8,
  },
  suggestionPillText: {
    fontSize: 15,
    textAlign: 'center',
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
  messagesList: {
    paddingHorizontal: 12,
    paddingVertical: 16,
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
});