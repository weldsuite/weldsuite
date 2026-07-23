import { Tabs } from "expo-router";
import React, { useState, useEffect, useRef } from "react";
import { HeadphonesIcon, Users, ChevronLeft, Inbox, Menu, Home, Settings, HelpCircle, MessageSquare, BookOpen, X, ArrowUp, ImageIcon as Image, Zap, MessageSquarePlus, History, LayoutDashboard } from 'lucide-react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, Modal, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, Easing, Keyboard, LayoutAnimation, UIManager, SafeAreaView, StatusBar, FlatList } from 'react-native';
import { router } from 'expo-router';
import WeldAgentLogo from '@/components/WeldAgentLogo';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { CollapsibleHeaderProvider, useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';

// LayoutAnimation on Android is handled by CollapsibleHeaderContext

interface AgentMessage {
  id: string;
  text: string;
  sender: 'user' | 'agent';
  timestamp: string;
}

function HelpdeskTabsContent() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isTablet = useShouldShowMiniSidebar();
  const [agentModalVisible, setAgentModalVisible] = useState(false);
  const [menuModalVisible, setMenuModalVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const menuSlideAnim = useRef(new Animated.Value(-320)).current;
  const backdropOpacityAnim = useRef(new Animated.Value(0)).current;
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    if (menuModalVisible) {
      backdropOpacityAnim.setValue(1);
      menuSlideAnim.setValue(-320);

      requestAnimationFrame(() => {
        Animated.spring(menuSlideAnim, {
          toValue: 0,
          useNativeDriver: true,
          friction: 9,
          tension: 50,
        }).start();
      });
    }
  }, [menuModalVisible]);

  const closeMenu = () => {
    Animated.timing(menuSlideAnim, {
      toValue: -320,
      duration: 250,
      useNativeDriver: true,
      easing: Easing.out(Easing.ease),
    }).start(() => {
      setMenuModalVisible(false);
      backdropOpacityAnim.setValue(0);
    });
  };

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

  const { isCollapsed } = useCollapsibleHeader();
  const HEADER_HEIGHT = 44;

  const renderHeader = () => {
    // On mobile, no separate header — Home button is in each tab's content
    if (!isTablet) {
      return null;
    }

    // Tablet header (not collapsible)
    return (
      <View style={[styles.header, { backgroundColor: colors.background, paddingTop: insets.top + 12, borderBottomWidth: 1, borderBottomColor: '#ebebeb' }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Helpdesk</Text>
        </View>
      </View>
    );
  };

  return (
    <>
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: !isTablet ? insets.top : 0 }}>
        {/* Custom Header */}
        {renderHeader()}

      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.text,
          tabBarInactiveTintColor: colors.muted,
          headerShown: false,
          tabBarStyle: {
          backgroundColor: colors.cardBackground,
          height: 50 + insets.bottom,
          paddingBottom: insets.bottom,
          borderTopColor: '#EBEBEB',
          borderTopWidth: 0.5,
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
        name="inbox"
        options={{
          title: "Inbox",
          tabBarIcon: ({ color }) => (
            <Inbox size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="contacts"
        options={{
          title: "Contacts",
          tabBarIcon: ({ color }) => (
            <Users size={20} color={color} strokeWidth={2} />
          ),
        }}
      />
      </Tabs>
    </View>

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

    {/* Side Menu */}
    <Modal
      animationType="none"
      transparent={true}
      visible={menuModalVisible}
      onRequestClose={closeMenu}
    >
      <Animated.View style={[styles.sideMenuOverlay, { opacity: backdropOpacityAnim }]}>
        <TouchableOpacity
          style={{ flex: 1 }}
          activeOpacity={1}
          onPress={closeMenu}
        />
        <Animated.View
          style={[
            styles.sideMenuContainer,
            {
              backgroundColor: colors.background,
              transform: [{ translateX: menuSlideAnim }],
            }
          ]}
          onStartShouldSetResponder={() => true}
        >
          {/* Menu Header */}
          <View style={styles.sideMenuHeader}>
            <Text style={[styles.sideMenuTitle, { color: colors.text }]}>HelpDesk</Text>
            <TouchableOpacity
              onPress={closeMenu}
              style={styles.sideMenuCloseButton}
            >
              <X size={20} color={colors.muted} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.sideMenuContent} showsVerticalScrollIndicator={false}>
            {/* Section Label */}
            <Text style={[styles.sideMenuSectionLabel, { color: colors.muted }]}>Navigation</Text>

            {/* Primary Navigation */}
            <View style={styles.sideMenuSection}>
              <TouchableOpacity
                style={[styles.sideMenuItem, { backgroundColor: '#F3F4F6', borderRadius: 10 }]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/helpdesk/(tabs)' as any), 300);
                }}
              >
                <View style={[styles.sideMenuIconContainer, { backgroundColor: '#E5E7EB' }]}>
                  <Home size={18} color={colors.text} strokeWidth={2} />
                </View>
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Home</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.sideMenuItem}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/helpdesk/(tabs)/inbox' as any), 300);
                }}
              >
                <View style={[styles.sideMenuIconContainer, { backgroundColor: '#F3F4F6' }]}>
                  <Inbox size={18} color={colors.text} strokeWidth={2} />
                </View>
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Inbox</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.sideMenuItem}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/helpdesk/(tabs)/contacts' as any), 300);
                }}
              >
                <View style={[styles.sideMenuIconContainer, { backgroundColor: '#F3F4F6' }]}>
                  <Users size={18} color={colors.text} strokeWidth={2} />
                </View>
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Contacts</Text>
              </TouchableOpacity>
            </View>

            {/* Section Label */}
            <Text style={[styles.sideMenuSectionLabel, { color: colors.muted }]}>Tools</Text>

            {/* Secondary Navigation */}
            <View style={styles.sideMenuSection}>
              <TouchableOpacity
                style={[styles.sideMenuItem, { opacity: 0.4 }]}
                disabled
              >
                <View style={[styles.sideMenuIconContainer, { backgroundColor: '#F3F4F6' }]}>
                  <BookOpen size={18} color={colors.muted} strokeWidth={2} />
                </View>
                <Text style={[styles.sideMenuItemText, { color: colors.muted }]}>Knowledge Base</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.sideMenuItem}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/helpdesk/(tabs)/inbox' as any), 300);
                }}
              >
                <View style={[styles.sideMenuIconContainer, { backgroundColor: '#F3F4F6' }]}>
                  <MessageSquare size={18} color={colors.text} strokeWidth={2} />
                </View>
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Live Chat</Text>
              </TouchableOpacity>
            </View>

            {/* Section Label */}
            <Text style={[styles.sideMenuSectionLabel, { color: colors.muted }]}>Settings</Text>

            {/* Settings Section */}
            <View style={styles.sideMenuSection}>
              <TouchableOpacity
                style={[styles.sideMenuItem, { opacity: 0.4 }]}
                disabled
              >
                <View style={[styles.sideMenuIconContainer, { backgroundColor: '#F3F4F6' }]}>
                  <Settings size={18} color={colors.muted} strokeWidth={2} />
                </View>
                <Text style={[styles.sideMenuItemText, { color: colors.muted }]}>Settings</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sideMenuItem, { opacity: 0.4 }]}
                disabled
              >
                <View style={[styles.sideMenuIconContainer, { backgroundColor: '#F3F4F6' }]}>
                  <HelpCircle size={18} color={colors.muted} strokeWidth={2} />
                </View>
                <Text style={[styles.sideMenuItemText, { color: colors.muted }]}>Help & Support</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={[styles.sideMenuFooter, { borderTopColor: colors.divider }]}>
            <TouchableOpacity
              style={styles.sideMenuFooterButton}
              onPress={() => {
                closeMenu();
                setTimeout(() => router.replace('/(tabs)'), 300);
              }}
            >
              <Home size={18} color={colors.muted} strokeWidth={2} />
              <Text style={[styles.sideMenuFooterText, { color: colors.muted }]}>Back to Home</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
    </>
  );
}

export default function HelpdeskTabsLayout() {
  return (
    <CollapsibleHeaderProvider>
      <HelpdeskTabsContent />
    </CollapsibleHeaderProvider>
  );
}

const styles = StyleSheet.create({
  collapsibleHeader: {
    overflow: 'hidden',
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  header: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
    paddingBottom: 12,
    paddingHorizontal: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  menuButton: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
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
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  agentButton: {
    padding: 4,
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
  sideMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sideMenuContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 300,
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  sideMenuHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  sideMenuTitle: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  sideMenuCloseButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideMenuContent: {
    flex: 1,
    paddingHorizontal: 16,
  },
  sideMenuSectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  sideMenuSection: {
    gap: 4,
  },
  sideMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 12,
  },
  sideMenuIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideMenuItemText: {
    fontSize: 15,
    fontWeight: '500',
  },
  sideMenuFooter: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderTopWidth: 1,
  },
  sideMenuFooterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sideMenuFooterText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
