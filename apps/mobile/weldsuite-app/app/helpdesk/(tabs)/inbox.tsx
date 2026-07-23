import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  TextInput,
  Modal,
  ScrollView,
  StatusBar,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSession, useUser } from '@clerk/expo';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { X, Clock, Archive, Star, Menu as MenuIcon, Search, Plus, SlidersHorizontal, Inbox as InboxIcon, Users } from 'lucide-react-native';
import AppDrawer from '@/components/layout/AppDrawer';
import Svg, { Path as SvgPath } from 'react-native-svg';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import api, { Conversation, getApiErrorMessage } from '@/services/api';
import { useInboxRealtime } from '@/hooks/useInboxRealtime';
import { ConnectionBanner, ConversationDetailPanel, InboxSkeleton } from '@/components/helpdesk';
import type { InboxConversation, InboxNewMessageEvent, ConnectionState } from '@/hooks/useInboxRealtime';
import { useTopic } from '@weldsuite/realtime/react';
import { topics } from '@weldsuite/realtime/topics';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';

// Split view constants
const SPLIT_VIEW_MIN_WIDTH = 768;
const CONVERSATION_LIST_WIDTH = 380;

// Format relative time for conversation list
const formatRelativeTime = (dateString: string | null | undefined): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  // For older messages, show the date
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Channel tabs configuration
const CHANNEL_TABS = [
  { key: null, label: 'All', icon: 'chatbubbles-outline' as const },
  { key: 'web', label: 'Tickets', icon: 'ticket-outline' as const },
  { key: 'email', label: 'Email', icon: 'mail-outline' as const },
  { key: 'chat', label: 'Live Chat', icon: 'chatbubble-outline' as const },
  { key: 'discord', label: 'Discord', icon: 'logo-discord' as const },
];

const CONVERSATION_STATUS_CONFIG = {
  active: {
    label: 'Open',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
    icon: 'mail-open-outline' as const,
  },
  pending: {
    label: 'Pending',
    color: '#7C2D12',
    backgroundColor: '#FED7AA',
    icon: 'time-outline' as const,
  },
  snoozed: {
    label: 'Snoozed',
    color: '#5B21B6',
    backgroundColor: '#EDE9FE',
    icon: 'hourglass-outline' as const,
  },
  resolved: {
    label: 'Resolved',
    color: '#14532D',
    backgroundColor: '#DCFCE7',
    icon: 'checkmark-done-outline' as const,
  },
  closed: {
    label: 'Closed',
    color: '#374151',
    backgroundColor: '#F3F4F6',
    icon: 'lock-closed-outline' as const,
  },
};

const SORT_OPTIONS = [
  { key: 'createdat', label: 'Newest First', order: 'desc' },
  { key: 'createdat', label: 'Oldest First', order: 'asc' },
  { key: 'priority', label: 'Priority', order: 'desc' },
  { key: 'updatedat', label: 'Last Updated', order: 'desc' },
];

export default function InboxScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const { session } = useSession();
  const { user } = useUser();
  const currentUserId = user?.id || session?.user?.id || '';
  const currentUserName = user?.fullName || session?.user?.fullName || 'Agent';
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const { onScroll: onCollapsibleScroll, resetHeader } = useCollapsibleHeader();

  // Check if we should show split view (iPad/tablet)
  const isSplitView = windowWidth >= SPLIT_VIEW_MIN_WIDTH;

  // Reset header when tab becomes active
  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);

  const drawerMenuItems = [
    {
      key: 'inbox',
      label: 'Inbox',
      icon: <InboxIcon size={20} color="#374151" strokeWidth={2} />,
      onPress: () => {},
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    {
      key: 'contacts',
      label: 'Contacts',
      icon: <Users size={20} color="#374151" strokeWidth={2} />,
      onPress: () => router.push('/helpdesk/(tabs)/contacts' as any),
    },
  ];
  const [searchQuery, setSearchQuery] = useState('');
  const [statusUpdateModalVisible, setStatusUpdateModalVisible] = useState(false);
  const [statusFilterModalVisible, setStatusFilterModalVisible] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const searchTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const loadConversationsRef = React.useRef<(isLoadingMore?: boolean) => Promise<void>>();

  // Convert InboxConversation to Conversation format
  const inboxToConversation = useCallback((inbox: InboxConversation): Conversation => ({
    id: inbox.id,
    subject: inbox.subject,
    channel: inbox.channel,
    status: inbox.status,
    priority: inbox.priority,
    contactName: inbox.contactName,
    customerName: inbox.customerName,
    customerId: inbox.customerId,
    assignedToId: inbox.assignedToId,
    assignedToName: inbox.assignedToName,
    lastMessagePreview: inbox.lastMessagePreview,
    lastMessageTime: inbox.lastMessageTime,
    unreadCount: inbox.unreadCount,
    isRead: inbox.isRead,
    isStarred: inbox.isStarred,
    createdAt: inbox.createdAt,
    updatedAt: inbox.updatedAt,
  }), []);

  // Handle new conversation from realtime
  const handleNewConversation = useCallback((conv: InboxConversation) => {
    // Hide conversations assigned to other agents
    if (conv.assignedToId && conv.assignedToId !== currentUserId) return;
    setConversations(prev => {
      if (prev.some(c => c.id === conv.id)) return prev;
      return [inboxToConversation(conv), ...prev];
    });
    setTotalCount(prev => prev + 1);
    toast.info('New conversation received');
  }, [inboxToConversation, toast, currentUserId]);

  // Handle conversation updated from realtime
  const handleConversationUpdated = useCallback((conv: InboxConversation) => {
    // Remove if now assigned to another agent
    if (conv.assignedToId && conv.assignedToId !== currentUserId) {
      setConversations(prev => prev.filter(c => c.id !== conv.id));
      return;
    }
    setConversations(prev =>
      prev.map(c => c.id === conv.id ? inboxToConversation(conv) : c)
    );
  }, [inboxToConversation, currentUserId]);

  // Handle new message from realtime
  const handleNewMessage = useCallback((data: InboxNewMessageEvent) => {
    setConversations(prev => {
      const existingConv = prev.find(c => c.id === data.conversationId);
      if (!existingConv) return prev;

      const updatedConv = {
        ...existingConv,
        lastMessagePreview: data.preview,
        lastMessageTime: data.timestamp,
        unreadCount: (existingConv.unreadCount || 0) + 1,
        isRead: false,
      };

      const filtered = prev.filter(c => c.id !== data.conversationId);
      return [updatedConv, ...filtered];
    });
    toast.info(`New message: ${data.preview?.substring(0, 50)}...`);
  }, [toast]);

  // Handle conversation closed from realtime
  const handleConversationClosed = useCallback((conversationId: string) => {
    setConversations(prev => prev.map(c =>
      c.id === conversationId ? { ...c, status: 'closed' as const } : c
    ));
  }, []);

  // Handle conversation read by customer from realtime
  const handleConversationRead = useCallback((conversationId: string) => {
    setConversations(prev => prev.map(c =>
      c.id === conversationId ? { ...c, isRead: true, unreadCount: 0 } : c
    ));
  }, []);

  // Handle connection state changes
  const handleConnectionStateChange = useCallback((state: ConnectionState) => {
    setConnectionState(state);
  }, []);

  // Setup realtime updates
  const { isConnected, connect: connectRealtime } = useInboxRealtime({
    agentId: session?.user?.id || '',
    agentName: session?.user?.fullName || session?.user?.firstName || 'Agent',
    agentEmail: session?.user?.primaryEmailAddress?.emailAddress,
    onNewConversation: handleNewConversation,
    onConversationUpdated: handleConversationUpdated,
    onNewMessage: handleNewMessage,
    onConversationClosed: handleConversationClosed,
    onConversationRead: handleConversationRead,
    onConnectionStateChange: handleConnectionStateChange,
    autoConnect: !!session?.user?.id,
  });

  // Reset to page 1 when filters change (don't clear conversations — replace on load)
  useEffect(() => {
    setPage(1);
    setHasMore(true);
  }, [selectedChannel, selectedStatus, sortBy, sortOrder]);

  // Debounce search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      setPage(1);
      setHasMore(true);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery]);

  // Load conversations when page changes
  useEffect(() => {
    loadConversations();
  }, [page, selectedChannel, selectedStatus, sortBy, sortOrder]);

  // Keep ref in sync so useFocusEffect always calls the latest version
  React.useEffect(() => {
    loadConversationsRef.current = loadConversations;
  });

  // Refetch conversations when screen gains focus (e.g. returning from a conversation)
  useFocusEffect(
    useCallback(() => {
      loadConversationsRef.current?.();
    }, [])
  );

  // Refresh conversation list when a ticket entity changes on another client
  useTopic(topics.ticket(), () => {
    loadConversationsRef.current?.();
  });

  // Auto-select first conversation in split view
  useEffect(() => {
    if (isSplitView && conversations.length > 0 && !selectedConversationId) {
      setSelectedConversationId(conversations[0].id);
    }
  }, [isSplitView, conversations, selectedConversationId]);

  const loadConversations = async (isLoadingMore = false) => {
    if (isLoadingMore) {
      if (loadingMore || !hasMore) return;
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await api.getConversations({
        search: searchQuery || undefined,
        channel: selectedChannel || undefined,
        status: selectedStatus || undefined,
        page,
        limit: 20,
        sortBy,
        sortOrder,
      });

      if (response.success && response.data) {
        const rawItems = response.data.data || response.data.items || [];
        const total = response.data.meta?.total || 0;
        const limit = response.data.meta?.limit || 20;

        // Map API fields (preview, lastMessage, lastMessageAt) to Conversation fields
        const items = rawItems.map((item: any) => ({
          ...item,
          lastMessagePreview: item.lastMessage || item.lastMessagePreview || item.preview || null,
          lastMessageTime: item.lastMessageTime || item.lastMessageAt || null,
        }));

        if (page === 1) {
          setConversations(items);
        } else {
          setConversations(prev => [...prev, ...items]);
        }

        setTotalCount(total);
        setUnreadCount(response.data.meta?.unreadCount ?? 0);
        setHasMore(items.length === limit && conversations.length + items.length < total);
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to load conversations'));
      }
    } catch (error) {
      console.error('Error loading conversations:', error);
      toast.error('Failed to load conversations');
    } finally {
      setLoading(false);
      setInitialLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  };

  const handleLoadMore = () => {
    if (!loadingMore && hasMore && !loading) {
      setPage(prev => prev + 1);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    loadConversations();
  };

  const handleSort = (key: string, order: string) => {
    setSortBy(key);
    setSortOrder(order as 'asc' | 'desc');
    setSortModalVisible(false);
  };

  const getCurrentSortLabel = () => {
    const option = SORT_OPTIONS.find(o => o.key === sortBy && o.order === sortOrder);
    return option?.label || 'Newest First';
  };

  const handleConversationPress = (conversation: Conversation) => {
    // Auto-assign unassigned conversations to the current agent
    if (!conversation.assigneeId && currentUserId) {
      setConversations(prev => prev.map(c =>
        c.id === conversation.id ? { ...c, assigneeId: currentUserId, assigneeName: currentUserName } : c
      ));
      api.assignConversation(conversation.id, currentUserId, currentUserName).catch(() => {});
    }

    if (isSplitView) {
      setSelectedConversationId(conversation.id);
    } else {
      router.push(`/helpdesk/ticket/${conversation.id}` as any);
    }
  };

  const handleUpdateConversationStatus = (conversation: Conversation) => {
    setSelectedConversation(conversation);
    setStatusUpdateModalVisible(true);
  };

  const updateConversationStatus = async (newStatus: string) => {
    if (!selectedConversation) return;

    try {
      const response = await api.updateConversationStatus(selectedConversation.id, newStatus);

      if (response.success && response.data) {
        // app-api PATCH /conversations/:id returns only { id } — merge into
        // the existing row (and apply the new status locally) instead of
        // replacing it, or the row renders blank until the next refetch.
        setConversations(conversations.map(conv =>
          conv.id === selectedConversation.id
            ? { ...conv, ...response.data!, status: newStatus }
            : conv
        ));

        setStatusUpdateModalVisible(false);
        setSelectedConversation(null);
        toast.success('Conversation status updated');
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to update conversation status'));
      }
    } catch (error) {
      console.error('Error updating conversation status:', error);
      toast.error('Failed to update conversation status');
    }
  };

  const handleSnooze = async (item: Conversation) => {
    try {
      const response = await api.updateConversationStatus(item.id, 'snoozed');

      if (response.success) {
        // Remove from list (snoozed items go to snoozed filter)
        setConversations(prev => prev.filter(conv => conv.id !== item.id));
        setTotalCount(prev => prev - 1);
        // Clear selection if this was selected
        if (selectedConversationId === item.id) {
          setSelectedConversationId(null);
        }
        toast.success('Conversation snoozed');
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to snooze conversation'));
      }
    } catch (error) {
      toast.error('Failed to snooze conversation');
    }
  };

  const handleArchive = async (item: Conversation) => {
    try {
      const response = await api.updateConversationStatus(item.id, 'resolved');

      if (response.success) {
        // Remove from list
        setConversations(prev => prev.filter(conv => conv.id !== item.id));
        setTotalCount(prev => prev - 1);
        // Clear selection if this was selected
        if (selectedConversationId === item.id) {
          setSelectedConversationId(null);
        }
        toast.success('Conversation archived');
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to archive conversation'));
      }
    } catch (error) {
      toast.error('Failed to archive conversation');
    }
  };

  const handleClose = async (item: Conversation) => {
    try {
      const response = await api.updateConversationStatus(item.id, 'closed');

      if (response.success) {
        // Remove from list
        setConversations(prev => prev.filter(conv => conv.id !== item.id));
        setTotalCount(prev => prev - 1);
        // Clear selection if this was selected
        if (selectedConversationId === item.id) {
          setSelectedConversationId(null);
        }
        toast.success('Conversation closed');
      } else {
        toast.error(getApiErrorMessage(response.error, 'Failed to close conversation'));
      }
    } catch (error) {
      toast.error('Failed to close conversation');
    }
  };

  const renderRightActions = (item: Conversation) => {
    return (
      <View style={styles.swipeActionsContainer}>
        <TouchableOpacity
          style={[styles.swipeAction, { backgroundColor: '#F59E0B' }]}
          onPress={() => handleSnooze(item)}
        >
          <Clock size={20} color="#FFFFFF" />
          <Text style={styles.swipeActionText}>Snooze</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeAction, { backgroundColor: '#3B82F6' }]}
          onPress={() => handleArchive(item)}
        >
          <Archive size={20} color="#FFFFFF" />
          <Text style={styles.swipeActionText}>Archive</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeAction, { backgroundColor: '#EF4444' }]}
          onPress={() => handleClose(item)}
        >
          <X size={20} color="#FFFFFF" />
          <Text style={styles.swipeActionText}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const getChannelIcon = (type?: string): { name: keyof typeof Ionicons.glyphMap; color: string } => {
    switch (type) {
      case 'email':
        return { name: 'mail', color: '#6366F1' };
      case 'chat':
        return { name: 'chatbubble', color: '#10B981' };
      case 'discord':
        return { name: 'logo-discord', color: '#5865F2' };
      case 'slack':
        return { name: 'logo-slack', color: '#4A154B' };
      case 'ticket':
      default:
        return { name: 'ticket', color: '#3B82F6' };
    }
  };

  const renderChannelTabs = () => {
    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {CHANNEL_TABS.map((item) => (
            <TouchableOpacity
              key={item.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedChannel === item.key ? colors.text : colors.background,
                  borderColor: selectedChannel === item.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => setSelectedChannel(item.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedChannel === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderConversation = ({ item }: { item: Conversation }) => {
    const customerName = item.contactName || item.customerName || 'Unknown';
    const isUnread = !item.isRead;
    const unreadCount = item.unreadCount || 0;
    const channelIcon = getChannelIcon(item.channel);
    const isSelected = isSplitView && selectedConversationId === item.id;
    const timeAgo = formatRelativeTime(item.lastMessageTime || item.updatedAt);
    const isClosed = item.status === 'closed' || item.status === 'resolved';
    const statusConfig = CONVERSATION_STATUS_CONFIG[item.status as keyof typeof CONVERSATION_STATUS_CONFIG];
    const showStatusBadge = item.status && item.status !== 'active' && item.status !== 'open' && statusConfig;

    return (
      <Swipeable
        renderRightActions={() => renderRightActions(item)}
        overshootRight={false}
        friction={1.5}
        rightThreshold={30}
        enableTrackpadTwoFingerGesture
      >
        <TouchableOpacity
          onPress={() => handleConversationPress(item)}
          activeOpacity={0.7}
          delayPressIn={50}
          style={[
            styles.ticketItem,
            {
              backgroundColor: isSelected ? '#EFF6FF' : isUnread ? '#F0F7FF' : colors.background,
              borderBottomColor: colors.border,
              opacity: isClosed ? 0.55 : 1,
            },
            isSelected && styles.ticketItemSelected,
          ]}
        >
          <View style={styles.ticketContent}>
            <View style={styles.ticketLeft}>
              <View style={styles.ticketHeader}>
                {item.channel && item.channel !== 'web' && ['email', 'chat', 'discord'].includes(item.channel) && (
                  item.channel === 'chat' ? (
                    <Svg width={14} height={15} viewBox="0 0 669.41 731.76" style={{ marginRight: 0 }}>
                      <SvgPath d="M145.58,0h378.25c80.4,0,145.58,65.18,145.58,145.58v436.33s0,149.85,0,149.85l-244.49-149.85H145.58C65.18,581.91,0,516.73,0,436.33V145.58C0,65.18,65.18,0,145.58,0Z" fill="#1e8ff9" />
                    </Svg>
                  ) : (
                    <Ionicons name={channelIcon.name} size={16} color={channelIcon.color} style={{ marginRight: 0 }} />
                  )
                )}
                <Text
                  style={[
                    styles.customerName,
                    {
                      color: isUnread ? colors.text : '#6B7280',
                      fontWeight: isUnread ? '700' : '600',
                    }
                  ]}
                  numberOfLines={1}
                >
                  {customerName}
                </Text>
                {item.isStarred && (
                  <Star size={14} color="#F59E0B" fill="#F59E0B" />
                )}
                {isUnread && unreadCount > 0 && (
                  <View style={[styles.newMessageBadge, { backgroundColor: '#3B82F6' }]}>
                    <Text style={[styles.newMessageText, { color: '#FFFFFF' }]}>{unreadCount}</Text>
                  </View>
                )}
                {timeAgo && (
                  <Text style={[styles.timeAgo, { color: colors.muted }]}>
                    {timeAgo}
                  </Text>
                )}
              </View>
              <View style={styles.subjectRow}>
                <Text
                  style={[
                    styles.ticketSubject,
                    {
                      flex: 1,
                      color: isUnread ? colors.text : colors.muted,
                      fontWeight: isUnread ? '600' : '500',
                    }
                  ]}
                  numberOfLines={1}
                >
                  {item.subject}
                </Text>
                {showStatusBadge && (
                  <View style={[styles.statusBadge, { backgroundColor: statusConfig.backgroundColor }]}>
                    <Text style={[styles.statusBadgeText, { color: statusConfig.color }]}>
                      {statusConfig.label}
                    </Text>
                  </View>
                )}
              </View>
              <Text
                style={[
                  styles.messagePreview,
                  {
                    color: isUnread ? colors.text : colors.muted,
                    fontWeight: isUnread ? '500' : '400',
                  }
                ]}
                numberOfLines={1}
              >
                {item.lastMessagePreview || item.subject || 'No messages yet'}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
      </Swipeable>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      {loading ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : (
        <Text style={[styles.emptyText, { color: colors.muted }]}>No conversations found</Text>
      )}
    </View>
  );

  // Render conversation list content (used in both layouts)
  const renderConversationListContent = () => (
    <>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <TouchableOpacity
          onPress={() => setDrawerVisible(true)}
          style={styles.menuButton}
        >
          <MenuIcon size={20} color="#374151" strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Inbox{unreadCount > 0 ? ` (${unreadCount})` : ''}</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[
              styles.filterTextButton,
              {
                borderColor: selectedStatus ? colors.text : colors.buttonBorder,
              },
            ]}
            onPress={() => setStatusFilterModalVisible(true)}
          >
            <Text style={[styles.filterTextButtonLabel, { color: selectedStatus ? colors.text : colors.muted }]}>
              {selectedStatus ? CONVERSATION_STATUS_CONFIG[selectedStatus as keyof typeof CONVERSATION_STATUS_CONFIG]?.label : 'Filter'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.newTicketButton}
            onPress={() => router.push('/helpdesk/ticket/new' as any)}
          >
            <Plus size={17} color="#FFFFFF" strokeWidth={2.5} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search conversations..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <X size={18} color={colors.muted} strokeWidth={2} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {renderChannelTabs()}

      <FlatList
        data={conversations.filter(c => {
          const aId = c.assigneeId || (c as any).assignedToId;
          return !aId || aId === currentUserId;
        })}
        renderItem={renderConversation}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={!loading ? renderEmptyState : null}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.loadingMoreContainer}>
              <ActivityIndicator size="small" color={colors.text} />
            </View>
          ) : null
        }
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        showsVerticalScrollIndicator={false}
        onScroll={!isSplitView ? onCollapsibleScroll : undefined}
        scrollEventThrottle={16}
      />
    </>
  );

  const mainContent = (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Connection Banner */}
        <ConnectionBanner state={connectionState} onRetry={connectRealtime} />

        {isSplitView ? (
          // Split view for iPad
          <View style={styles.splitContainer}>
            {/* Left Panel - Conversation List */}
            <View style={[styles.conversationListPanel, { width: CONVERSATION_LIST_WIDTH, borderRightColor: colors.divider }]}>
              {renderConversationListContent()}
            </View>

            {/* Right Panel - Conversation Detail */}
            <View style={styles.conversationDetailPanel}>
              <ConversationDetailPanel
                conversationId={selectedConversationId}
                isEmbedded={true}
              />
            </View>
          </View>
        ) : (
          // Single view for iPhone
          renderConversationListContent()
        )}

      {/* Status Update Modal */}
      <Modal
        visible={statusUpdateModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setStatusUpdateModalVisible(false)}
      >
        <StatusBar barStyle="light-content" />
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <View>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Update Status</Text>
              {selectedConversation && (
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>{selectedConversation.subject}</Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => setStatusUpdateModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalContentScroll} showsVerticalScrollIndicator={false}>
            {Object.entries(CONVERSATION_STATUS_CONFIG).map(([status, config]) => (
              <TouchableOpacity
                key={status}
                style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                onPress={() => updateConversationStatus(status)}
              >
                <Text style={[styles.modalOptionText, { color: colors.text }]}>{config.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>

      {/* App Drawer */}
      <AppDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        currentApp="helpdesk"
        menuItems={drawerMenuItems}
        activeMenuItem="inbox"
      />

      {/* Status Filter Modal */}
      <Modal
        visible={statusFilterModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setStatusFilterModalVisible(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Filter by Status</Text>
            <TouchableOpacity
              onPress={() => setStatusFilterModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalContentScroll} showsVerticalScrollIndicator={false}>
            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.divider }]}
              onPress={() => {
                setSelectedStatus(null);
                setStatusFilterModalVisible(false);
              }}
            >
              <Text style={[styles.modalOptionText, { color: colors.text, fontWeight: selectedStatus === null ? '600' : '400' }]}>All</Text>
              {selectedStatus === null && <Ionicons name="checkmark" size={20} color={colors.text} />}
            </TouchableOpacity>
            {Object.entries(CONVERSATION_STATUS_CONFIG).map(([status, config]) => (
              <TouchableOpacity
                key={status}
                style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                onPress={() => {
                  setSelectedStatus(status);
                  setStatusFilterModalVisible(false);
                }}
              >
                <Text style={[styles.modalOptionText, { color: colors.text, fontWeight: selectedStatus === status ? '600' : '400' }]}>{config.label}</Text>
                {selectedStatus === status && <Ionicons name="checkmark" size={20} color={colors.text} />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>

      {/* Sort Modal */}
      <Modal
        visible={sortModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSortModalVisible(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Sort By</Text>
            <TouchableOpacity
              onPress={() => setSortModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalContentScroll} showsVerticalScrollIndicator={false}>
            {SORT_OPTIONS.map((option, index) => (
              <TouchableOpacity
                key={`${option.key}-${option.order}`}
                style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                onPress={() => handleSort(option.key, option.order)}
              >
                <Text
                  style={[
                    styles.modalOptionText,
                    {
                      color: colors.text,
                      fontWeight: sortBy === option.key && sortOrder === option.order ? '600' : '400'
                    }
                  ]}
                >
                  {option.label}
                </Text>
                {sortBy === option.key && sortOrder === option.order && (
                  <Ionicons name="checkmark" size={20} color={colors.text} />
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>
      </View>
    </GestureHandlerRootView>
  );

  return mainContent;
}

const styles = StyleSheet.create({
  sidebarContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebarContent: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  splitContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  conversationListPanel: {
    flex: 0,
    borderRightWidth: 0.5,
  },
  conversationDetailPanel: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filterContainer: {
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
    marginLeft: 12,
  },
  menuButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  filterTextButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  filterTextButtonLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  newTicketButton: {
    width: 33,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusFilterContainer: {
    paddingTop: 4,
    paddingBottom: 8,
  },
  statusFilterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  listContainer: {
    paddingHorizontal: 0,
  },
  ticketItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  ticketItemSelected: {
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
  },
  ticketContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  ticketLeft: {
    flex: 1,
    gap: 4,
  },
  ticketHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ticketSubject: {
    fontSize: 13,
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  customerName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  messagePreview: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '400',
  },
  newMessageBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  newMessageText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  timeAgo: {
    fontSize: 12,
    fontWeight: '400',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 12,
  },
  swipeActionsContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  swipeAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 75,
    paddingHorizontal: 8,
  },
  swipeActionText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 16,
  },
  modalSubtitle: {
    fontSize: 13,
    marginTop: 2,
    marginLeft: 16,
  },
  closeButton: {
    padding: 4,
    marginRight: 16,
  },
  modalContentScroll: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  modalOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  modalOptionText: {
    fontSize: 15,
    fontWeight: '400',
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  sortButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  loadingMoreContainer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
});
