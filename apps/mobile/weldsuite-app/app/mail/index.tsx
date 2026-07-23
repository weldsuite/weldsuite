import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import {
  StyleSheet,
  FlatList,
  SectionList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  TextInput,
  Animated,
  Dimensions,
  ScrollView,
  Modal,
  useWindowDimensions,
  ActionSheetIOS,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import {
  Star, Paperclip, Edit3, Menu, Search, Mail, ChevronLeft, Inbox, Send, FileText,
  Trash2, Archive, AlertCircle, Home, Users, Package, FolderKanban, ChevronDown,
  Briefcase, CreditCard, X, Wifi, WifiOff, ShoppingCart, Headphones, CheckSquare,
  Warehouse, Calculator, Truck, LayoutGrid, Clock
} from 'lucide-react-native';
import Svg, { Defs, Pattern as SvgPattern, Path as SvgPath, Rect as SvgRect } from 'react-native-svg';
import AppDrawer from '@/components/layout/AppDrawer';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import { Gesture, GestureDetector, RectButton } from 'react-native-gesture-handler';
import ReanimatedAnimated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { useMail, type Email, type EmailAccount, type EmailLabel } from '@/contexts/MailContext';
import { useToast } from '@/contexts/ToastContext';
import EmailDetailPanel from '@/components/mail/EmailDetailPanel';
import ComposeEmailPanel from '@/components/mail/ComposeEmailPanel';

const { width } = Dimensions.get('window');
const screenWidth = width;
const DRAWER_WIDTH = width - 56;

// Minimum width to show split view (iPad portrait and larger)
const SPLIT_VIEW_MIN_WIDTH = 768;
const EMAIL_LIST_WIDTH = 380;
// Connection Banner component
const ConnectionBanner = memo(({ isConnected, realtimeState }: { isConnected: boolean; realtimeState: string }) => {
  if (isConnected && realtimeState === 'connected') return null;

  const isOffline = !isConnected;
  const isRealtimeDisconnected = realtimeState !== 'connected' && realtimeState !== 'initialized';

  if (!isOffline && !isRealtimeDisconnected) return null;

  return (
    <View style={[connectionStyles.banner, { backgroundColor: isOffline ? '#EF4444' : '#F59E0B' }]}>
      {isOffline ? (
        <WifiOff size={14} color="#FFFFFF" strokeWidth={2} />
      ) : (
        <Wifi size={14} color="#FFFFFF" strokeWidth={2} />
      )}
      <Text style={connectionStyles.bannerText}>
        {isOffline ? 'You are offline' : 'Reconnecting...'}
      </Text>
    </View>
  );
});

// Swipeable Email Item Component
const SwipeableEmailItem = ({ item, onPress, onDelete, onArchive, onSnooze, colors, getAvatarColor, isSelected }: {
  item: Email;
  onPress: (email: Email) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onSnooze: (id: string) => void;
  colors: any;
  getAvatarColor: (name: string) => string;
  isSelected?: boolean;
}) => {
  const senderName = typeof item.from === 'string'
    ? item.from
    : ((item.from as any)?.name || (item.from as any)?.email || '(No sender)');

  const renderRightActions = () => (
    <View style={styles.swipeActionsContainer}>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: '#F59E0B' }]}
        onPress={() => onSnooze(item.id)}
      >
        <Clock size={20} color="#FFFFFF" />
        <Text style={styles.swipeActionText}>Snooze</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: '#3B82F6' }]}
        onPress={() => onArchive(item.id)}
      >
        <Archive size={20} color="#FFFFFF" />
        <Text style={styles.swipeActionText}>Archive</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: '#EF4444' }]}
        onPress={() => onDelete(item.id)}
      >
        <Trash2 size={20} color="#FFFFFF" />
        <Text style={styles.swipeActionText}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Swipeable
      renderRightActions={renderRightActions}
      overshootRight={false}
      friction={1.5}
      rightThreshold={30}
      enableTrackpadTwoFingerGesture
    >
      <TouchableOpacity
        onPress={() => onPress(item)}
        activeOpacity={0.7}
        delayPressIn={50}
        style={[
          styles.emailItem,
          {
            backgroundColor: isSelected ? '#EFF6FF' : colors.background,
          },
          isSelected && styles.emailItemSelected,
        ]}
      >
        <View style={styles.emailRow}>
          <View style={[styles.avatar, { backgroundColor: getAvatarColor(senderName) + '40' }]}>
            <Text style={[styles.avatarText, { color: getAvatarColor(senderName) }]}>
              {senderName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={styles.emailContent}>
            <View style={styles.emailTop}>
              <Text style={[
                styles.senderName,
                { color: item.isRead ? colors.muted : colors.text, fontWeight: item.isRead ? '400' : '600' }
              ]} numberOfLines={1}>
                {senderName}
              </Text>
              <View style={styles.emailMeta}>
                <Text style={[styles.emailTime, { color: colors.muted }]}>
                  {item.time}
                </Text>
                {item.hasAttachment && (
                  <Paperclip size={14} color={colors.muted} strokeWidth={2} />
                )}
                {item.isStarred && (
                  <Star size={14} color="#F59E0B" fill="#F59E0B" strokeWidth={2} />
                )}
              </View>
            </View>
            <Text style={[
              styles.subject,
              { color: item.isRead ? colors.muted : colors.text, fontWeight: item.isRead ? '400' : '600' }
            ]} numberOfLines={1}>
              {item.subject}
            </Text>
            <Text style={[styles.preview, { color: colors.muted }]} numberOfLines={1}>
              {item.preview}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
};

export default function MailScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { width: windowWidth } = useWindowDimensions();

  // Check if we should show split view (iPad/tablet)
  const isSplitView = windowWidth >= SPLIT_VIEW_MIN_WIDTH;

  // Use MailContext instead of local state
  const {
    accounts,
    selectedAccount,
    labels,
    selectedLabel,
    messages,
    loading,
    hasMore,
    isConnected,
    realtimeState,
    loadAccounts,
    selectAccount,
    loadLabels,
    selectLabel,
    loadMessages,
    loadMoreMessages,
    refreshMessages,
    markAsRead,
    toggleStar,
    deleteMessage,
    archiveMessage,
  } = useMail();

  const [searchQuery, setSearchQuery] = useState('');
  const [showDrawer, setShowDrawer] = useState(false);
  const [appDrawerVisible, setAppDrawerVisible] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);

  // Default labels for when API returns none
  const defaultLabels: EmailLabel[] = [
    { id: 'inbox', slug: 'INBOX', name: 'Inbox', isSystem: true },
    { id: 'starred', slug: 'STARRED', name: 'Starred', isSystem: true },
    { id: 'sent', slug: 'SENT', name: 'Sent', isSystem: true },
    { id: 'drafts', slug: 'DRAFTS', name: 'Drafts', isSystem: true },
    { id: 'trash', slug: 'TRASH', name: 'Trash', isSystem: true },
    { id: 'spam', slug: 'SPAM', name: 'Spam', isSystem: true },
    { id: 'archive', slug: 'ARCHIVE', name: 'Archive', isSystem: true },
  ];

  const [refreshing, setRefreshing] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const drawerTranslateX = useSharedValue(-DRAWER_WIDTH);
  const drawerWasSwiping = useRef(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout>();
  const pendingLabelRef = useRef<EmailLabel | null>(null);

  // Load accounts on mount
  useEffect(() => {
    loadAccounts();
  }, []);

  // Load labels when account changes
  useEffect(() => {
    if (selectedAccount) {
      loadLabels(selectedAccount.id);
    }
  }, [selectedAccount?.id]);

  // Load emails when account or label changes
  useEffect(() => {
    if (selectedAccount) {
      loadMessages({ accountId: selectedAccount.id, label: selectedLabel?.slug });
    }
  }, [selectedAccount?.id, selectedLabel?.id]);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      if (selectedAccount) {
        loadMessages({
          accountId: selectedAccount.id,
          label: selectedLabel?.slug,
          search: searchQuery || undefined
        }, true);
      }
    }, 500);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery]);

  // Auto-select first email in split view (like Gmail)
  useEffect(() => {
    if (isSplitView && messages.length > 0 && !selectedEmailId) {
      setSelectedEmailId(messages[0].id);
    }
  }, [isSplitView, messages, selectedEmailId]);

  const doCloseDrawer = useCallback(() => {
    setShowDrawer(false);
    setDrawerVisible(false);
    if (pendingLabelRef.current) {
      selectLabel(pendingLabelRef.current);
      pendingLabelRef.current = null;
    }
  }, [selectLabel]);

  const openDrawer = useCallback(() => {
    setDrawerVisible(true);
    setShowDrawer(true);
    drawerTranslateX.value = withSpring(0, { damping: 25, stiffness: 200 });
  }, []);

  const closeDrawer = useCallback(() => {
    drawerTranslateX.value = withSpring(-DRAWER_WIDTH, { damping: 25, stiffness: 200 }, (finished) => {
      if (finished) runOnJS(doCloseDrawer)();
    });
  }, [doCloseDrawer]);

  const drawerScrollNativeGesture = useMemo(() => Gesture.Native(), []);

  const markDrawerSwiping = useCallback(() => { drawerWasSwiping.current = true; }, []);
  const clearDrawerSwiping = useCallback(() => {
    setTimeout(() => { drawerWasSwiping.current = false; }, 200);
  }, []);
  const drawerSafePress = useCallback((fn: () => void) => () => {
    if (drawerWasSwiping.current) return;
    fn();
  }, []);

  const drawerPanGesture = useMemo(() =>
    Gesture.Pan()
      .activeOffsetX([-10, 10])
      .simultaneousWithExternalGesture(drawerScrollNativeGesture)
      .onStart(() => {
        runOnJS(markDrawerSwiping)();
      })
      .onUpdate((e) => {
        drawerTranslateX.value = Math.min(0, Math.max(-DRAWER_WIDTH, e.translationX));
      })
      .onEnd((e) => {
        runOnJS(clearDrawerSwiping)();
        const shouldClose = e.velocityX < -300 || drawerTranslateX.value < -DRAWER_WIDTH * 0.3;
        if (shouldClose) {
          drawerTranslateX.value = withSpring(-DRAWER_WIDTH, { damping: 25, stiffness: 200 }, (finished) => {
            if (finished) runOnJS(doCloseDrawer)();
          });
        } else {
          drawerTranslateX.value = withSpring(0, { damping: 25, stiffness: 200 });
        }
      })
      .onFinalize(() => {
        runOnJS(clearDrawerSwiping)();
      }),
    [doCloseDrawer, drawerScrollNativeGesture, markDrawerSwiping, clearDrawerSwiping],
  );

  const drawerOverlayTap = useMemo(() =>
    Gesture.Tap().onEnd(() => {
      drawerTranslateX.value = withSpring(-DRAWER_WIDTH, { damping: 25, stiffness: 200 }, (finished) => {
        if (finished) runOnJS(doCloseDrawer)();
      });
    }),
    [doCloseDrawer],
  );

  const drawerComposedGesture = useMemo(() =>
    Gesture.Race(drawerPanGesture, drawerOverlayTap),
    [drawerPanGesture, drawerOverlayTap],
  );

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drawerTranslateX.value }],
  }));

  const drawerOverlayStyle = useAnimatedStyle(() => ({
    opacity: (drawerTranslateX.value + DRAWER_WIDTH) / DRAWER_WIDTH * 0.5,
  }));

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshMessages();
    setRefreshing(false);
  };

  const handleLoadMore = () => {
    if (!loading.messages && hasMore) {
      loadMoreMessages();
    }
  };

  const handleEmailPress = useCallback(async (email: Email) => {
    // Check if email is a draft - open in compose
    if (email.labels?.includes('DRAFTS') || email.labels?.includes('DRAFT')) {
      if (isSplitView) {
        // TODO: Add draft editing in split view
        router.push(`/mail/compose?draftId=${email.id}` as any);
      } else {
        router.push(`/mail/compose?draftId=${email.id}` as any);
      }
      return;
    }

    // Mark as read
    if (!email.isRead) {
      markAsRead(email.id, true);
    }

    // In split view, show detail in right panel; otherwise navigate
    if (isSplitView) {
      setIsComposing(false);
      setSelectedEmailId(email.id);
    } else {
      router.push(`/mail/${email.id}` as any);
    }
  }, [markAsRead, isSplitView]);

  const handleStarToggle = useCallback(async (emailId: string) => {
    await toggleStar(emailId);
  }, [toggleStar]);

  const handleDelete = useCallback(async (emailId: string) => {
    const success = await deleteMessage(emailId);
    if (success) {
      toast.success('Email deleted');
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
    } else {
      toast.error('Failed to delete email');
    }
  }, [deleteMessage, isConnected]);

  const handleArchive = useCallback(async (emailId: string) => {
    const success = await archiveMessage(emailId);
    if (success) {
      toast.success('Email archived');
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
    } else {
      toast.error('Failed to archive email');
    }
  }, [archiveMessage, isConnected]);

  const handleSnooze = useCallback(async (emailId: string) => {
    // For now, just show a toast - snooze functionality can be implemented later
    toast.success('Email snoozed for 1 hour');
  }, []);

  // Handle closing the detail panel in split view
  const handleCloseDetail = useCallback(() => {
    setSelectedEmailId(null);
  }, []);

  const showLabelActionSheet = () => {
    const labelList = displayedLabels;
    const labelNames = labelList.map(l => l.name);
    const options = ['Cancel', ...labelNames];

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
          title: 'Select Label',
        },
        (buttonIndex) => {
          if (buttonIndex > 0) {
            const label = labelList[buttonIndex - 1];
            selectLabel(label);
          }
        }
      );
    } else {
      // For Android, fall back to drawer
      setShowDrawer(!showDrawer);
    }
  };

  const toggleDrawer = () => {
    if (showDrawer) {
      closeDrawer();
    } else {
      openDrawer();
    }
  };

  const handleSelectLabel = (label: EmailLabel) => {
    pendingLabelRef.current = label;
    closeDrawer();
  };

  const switchAccount = (account: EmailAccount) => {
    selectAccount(account);
    setShowUserModal(false);
  };

  const getLabelIcon = (slug: string) => {
    switch (slug) {
      case 'INBOX': return Inbox;
      case 'STARRED': return Star;
      case 'SENT': return Send;
      case 'DRAFTS': case 'DRAFT': return FileText;
      case 'TRASH': return Trash2;
      case 'SPAM': return AlertCircle;
      case 'ARCHIVE': return Archive;
      case 'IMPORTANT': return AlertCircle;
      case 'SNOOZED': return Clock;
      default: return Mail;
    }
  };

  const getAvatarColor = (name: string) => {
    const avatarColors = [
      '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444',
      '#06B6D4', '#EC4899', '#F97316', '#14B8A6', '#6366F1',
    ];

    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }

    return avatarColors[Math.abs(hash) % avatarColors.length];
  };

  const activeLabels = labels.length > 0 ? labels : defaultLabels;
  const appDrawerMenuItems = activeLabels.map(label => {
    const IconComponent = getLabelIcon(label.slug);
    return {
      key: label.id,
      label: label.name,
      icon: <IconComponent size={20} color="#374151" strokeWidth={2} />,
      onPress: () => selectLabel(label),
    };
  });

  const getDateSection = (dateString: string | undefined) => {
    if (!dateString) return 'Older';
    if (dateString === 'Today') return 'Today';
    if (dateString === 'Yesterday') return 'Yesterday';
    if (dateString.includes('days ago')) return 'This Week';
    return 'Older';
  };

  const groupEmailsByDate = (emails: Email[]) => {
    const grouped: { title: string; data: Email[] }[] = [];
    const sections: { [key: string]: Email[] } = {};

    emails.forEach(email => {
      const section = getDateSection(email.date);
      if (!sections[section]) {
        sections[section] = [];
      }
      sections[section].push(email);
    });

    const order = ['Today', 'Yesterday', 'This Week', 'Older'];
    order.forEach(sectionTitle => {
      if (sections[sectionTitle] && sections[sectionTitle].length > 0) {
        grouped.push({ title: sectionTitle, data: sections[sectionTitle] });
      }
    });

    return grouped;
  };

  const renderSectionHeader = ({ section }: { section: { title: string } }) => (
    <View style={[styles.sectionHeader, { backgroundColor: colors.background }]}>
      <Text style={[styles.sectionHeaderText, { color: '#6B7280' }]}>{section.title}</Text>
    </View>
  );

  const renderEmail = ({ item }: { item: Email }) => {
    return <SwipeableEmailItem
      item={item}
      onPress={handleEmailPress}
      onDelete={handleDelete}
      onArchive={handleArchive}
      onSnooze={handleSnooze}
      colors={colors}
      getAvatarColor={getAvatarColor}
      isSelected={isSplitView && selectedEmailId === item.id}
    />;
  };

  const renderFooter = () => {
    if (!loading.messages || messages.length === 0) return null;
    return (
      <View style={{ paddingVertical: 20 }}>
        <ActivityIndicator size="small" color={colors.text} />
      </View>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      {/* Grid pattern background with envelope illustration */}
      <View style={styles.emptyIllustrationWrapper}>
        <Svg width={220} height={155} style={StyleSheet.absoluteFill}>
          <Defs>
            <SvgPattern id="emptyGrid" width={24} height={24} patternUnits="userSpaceOnUse">
              <SvgPath d="M 24 0 L 0 0 0 24" fill="none" stroke={colors.divider} strokeWidth={0.5} strokeDasharray="3 3" />
            </SvgPattern>
          </Defs>
          <SvgRect width="100%" height="100%" fill="url(#emptyGrid)" />
        </Svg>
        {/* Envelope SVG */}
        <Svg width={100} height={100} viewBox="0 0 120 120" fill="none">
          <SvgRect x={20} y={35} width={80} height={55} rx={4} fill={colors.background} stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M20 90L52 65" stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M100 90L68 65" stroke={colors.divider} strokeWidth={1} />
          <SvgPath d="M20.5 38C20.5 36.3 21.8 35 23.5 35H96.5C98.2 35 99.5 36.3 99.5 38L60 64Z" fill={colors.divider} opacity={0.3} />
          <SvgPath d="M20 35L60 64L100 35" stroke={colors.divider} strokeWidth={1} fill="none" />
        </Svg>
      </View>
      <Text style={[styles.emptyText, { color: colors.text }]}>
        {selectedLabel ? `Nothing in ${selectedLabel.name}` : 'No emails yet'}
      </Text>
      <Text style={[styles.emptySubtext, { color: colors.muted }]}>
        {selectedLabel ? 'You\'re all caught up' : 'All caught up'}
      </Text>
    </View>
  );

  const displayedLabels = labels.length > 0 ? labels : defaultLabels;

  if (loading.accounts && accounts.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading emails...</Text>
      </View>
    );
  }

  // Render email list content for iPad split view (with account switcher at bottom)
  const renderEmailListContentForSplitView = () => (
    <>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, paddingTop: insets.top + 10, borderBottomColor: colors.divider }]}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <TouchableOpacity
              onPress={() => router.replace('/(tabs)')}
              style={styles.homeButton}
            >
              <Home size={18} color="#374151" strokeWidth={2} />
              <Text style={styles.homeButtonText}>Home</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={toggleDrawer}
              style={styles.menuButton}
            >
              <Menu size={20} color="#374151" strokeWidth={2} />
            </TouchableOpacity>
          </View>
          <View style={styles.headerRight}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>
              {selectedLabel?.name || 'Inbox'}
            </Text>
            <TouchableOpacity
              onPress={() => setShowUserModal(true)}
              style={[styles.accountAvatarButton, { backgroundColor: selectedAccount ? getAvatarColor(selectedAccount.displayName) : '#6B7280' }]}
            >
              <Text style={styles.accountAvatarText}>
                {selectedAccount?.displayName?.charAt(0).toUpperCase() || 'U'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Search Bar - Always visible */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search emails..."
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

      {/* Email List */}
      <SectionList
        sections={groupEmailsByDate(messages)}
        renderItem={renderEmail}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={(item) => `email-${item.id}`}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={!loading.messages ? renderEmptyState : null}
        ListFooterComponent={renderFooter}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
      />

      {/* Compose Button */}
      <View style={[styles.splitViewBottomBar, { paddingBottom: insets.bottom + 10 }]}>
        <TouchableOpacity
          style={[styles.fabAboveBar, { backgroundColor: '#3B82F6' }]}
          onPress={() => {
            setIsComposing(true);
            setSelectedEmailId(null);
          }}
          activeOpacity={0.9}
        >
          <Edit3 size={24} color="#FFFFFF" strokeWidth={2} />
        </TouchableOpacity>
      </View>
    </>
  );

  // Render email list content for iPhone (with menu button and FAB)
  const renderEmailListContent = () => (
    <>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => setAppDrawerVisible(true)}
            style={styles.menuButton}
          >
            <Menu size={20} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          <Text style={[styles.headerTitleCenter, { color: colors.text }]}>
            {selectedLabel?.name || 'Inbox'}
          </Text>
          <View style={styles.headerRight}>
            <TouchableOpacity
              onPress={() => setShowUserModal(true)}
              style={[styles.accountAvatarButton, { backgroundColor: selectedAccount ? getAvatarColor(selectedAccount.displayName) : '#6B7280' }]}
            >
              <Text style={styles.accountAvatarText}>
                {selectedAccount?.displayName?.charAt(0).toUpperCase() || 'U'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={16} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search emails..."
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

      {/* Email List */}
      <SectionList
        sections={groupEmailsByDate(messages)}
        renderItem={renderEmail}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={(item) => `email-${item.id}`}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={!loading.messages ? renderEmptyState : null}
        ListFooterComponent={renderFooter}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
      />

      {/* Floating Compose Button */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: '#3B82F6' }]}
        onPress={() => router.push('/mail/compose' as any)}
        activeOpacity={0.9}
      >
        <Edit3 size={24} color="#FFFFFF" strokeWidth={2} />
      </TouchableOpacity>
    </>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Connection Banner */}
      <ConnectionBanner isConnected={isConnected} realtimeState={realtimeState} />

      {isSplitView ? (
        // Split view for iPad - two columns (email list, detail) - mini sidebar comes from parent layout
        <View style={styles.splitContainer}>
          {/* Email List Panel */}
          <View style={[styles.emailListPanel, { width: EMAIL_LIST_WIDTH, borderRightColor: colors.divider }]}>
            {renderEmailListContentForSplitView()}
          </View>

          {/* Right Panel - Email Detail or Compose */}
          <View style={styles.emailDetailPanel}>
            {isComposing ? (
              <ComposeEmailPanel
                onClose={() => {
                  setIsComposing(false);
                  // Auto-select first email after closing compose
                  if (messages.length > 0) {
                    setSelectedEmailId(messages[0].id);
                  }
                }}
                onSent={() => {
                  refreshMessages();
                }}
                isEmbedded={true}
              />
            ) : (
              <EmailDetailPanel
                emailId={selectedEmailId}
                onClose={handleCloseDetail}
                showBackButton={false}
                isEmbedded={true}
              />
            )}
          </View>
        </View>
      ) : (
        // Single view for iPhone
        renderEmailListContent()
      )}

      {/* Gmail-style Drawer */}
      {drawerVisible && (
        <GestureDetector gesture={drawerComposedGesture}>
          <View style={StyleSheet.absoluteFill}>
            <ReanimatedAnimated.View style={[gmailDrawerStyles.overlay, drawerOverlayStyle]} />

            <ReanimatedAnimated.View
              style={[
                gmailDrawerStyles.drawer,
                { backgroundColor: colors.background },
                drawerStyle,
              ]}
            >
              {/* Gmail-style header with account info */}
              <View style={[gmailDrawerStyles.header, { paddingTop: insets.top + 16 }]}>
                <Text style={[gmailDrawerStyles.brandText, { color: colors.text }]}>WeldMail</Text>
              </View>

              <View style={[gmailDrawerStyles.divider, { backgroundColor: colors.divider }]} />

              {/* Labels list */}
              <GestureDetector gesture={drawerScrollNativeGesture}>
              <ReanimatedAnimated.ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={gmailDrawerStyles.scrollContent}
                style={{ flex: 1 }}
              >
                {displayedLabels.map(label => {
                  const isSelected = selectedLabel?.id === label.id;
                  const LabelIcon = getLabelIcon(label.slug);

                  return (
                    <RectButton
                      key={label.id}
                      style={[
                        gmailDrawerStyles.labelItem,
                        isSelected && gmailDrawerStyles.labelItemActive,
                      ]}
                      onPress={drawerSafePress(() => handleSelectLabel(label))}
                      rippleColor="rgba(0,0,0,0.08)"
                    >
                      <LabelIcon
                        size={20}
                        color={isSelected ? '#D93025' : '#5F6368'}
                        strokeWidth={isSelected ? 2 : 1.5}
                      />
                      <Text style={[
                        gmailDrawerStyles.labelText,
                        isSelected && gmailDrawerStyles.labelTextActive,
                      ]} numberOfLines={1}>
                        {label.name}
                      </Text>
                      {(label.unreadCount ?? 0) > 0 && (
                        <Text style={gmailDrawerStyles.labelCount}>
                          {label.unreadCount}
                        </Text>
                      )}
                    </RectButton>
                  );
                })}
              </ReanimatedAnimated.ScrollView>
              </GestureDetector>

              <View style={[gmailDrawerStyles.divider, { backgroundColor: colors.divider }]} />

              {/* Bottom account switcher */}
              <RectButton
                style={[gmailDrawerStyles.accountRow, { paddingBottom: insets.bottom + 12 }]}
                onPress={drawerSafePress(() => {
                  closeDrawer();
                  setShowUserModal(true);
                })}
                rippleColor="rgba(0,0,0,0.08)"
              >
                <View style={[gmailDrawerStyles.accountAvatar, { backgroundColor: selectedAccount ? getAvatarColor(selectedAccount.displayName) : '#6B7280' }]}>
                  <Text style={gmailDrawerStyles.accountAvatarText}>
                    {selectedAccount?.displayName?.charAt(0).toUpperCase() || 'U'}
                  </Text>
                </View>
                <View style={gmailDrawerStyles.accountInfo}>
                  <Text style={[gmailDrawerStyles.accountName, { color: colors.text }]} numberOfLines={1}>
                    {selectedAccount?.displayName || 'No account'}
                  </Text>
                  <Text style={[gmailDrawerStyles.accountEmail, { color: '#5F6368' }]} numberOfLines={1}>
                    {selectedAccount?.emailAddress || ''}
                  </Text>
                </View>
                <ChevronDown size={16} color="#5F6368" strokeWidth={2} />
              </RectButton>
            </ReanimatedAnimated.View>
          </View>
        </GestureDetector>
      )}

      {/* App Drawer */}
      <AppDrawer
        visible={appDrawerVisible}
        onClose={() => setAppDrawerVisible(false)}
        currentApp="mail"
        menuItems={appDrawerMenuItems}
        activeMenuItem={selectedLabel?.id || 'inbox'}
      />

      {/* User Switcher Modal */}
      <Modal
        visible={showUserModal}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={() => setShowUserModal(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={[styles.modalHeader, { backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text, marginLeft: 16 }]}>Switch Account</Text>
            <TouchableOpacity
              onPress={() => setShowUserModal(false)}
              style={styles.modalCloseButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalContent}>
            {accounts.map(account => {
              const isActive = selectedAccount?.id === account.id;
              const avatarColor = getAvatarColor(account.displayName);

              return (
                <TouchableOpacity
                  key={account.id}
                  style={[
                    styles.userOption,
                    isActive ? { backgroundColor: '#3B82F620', borderColor: '#3B82F6' } : { borderColor: colors.divider }
                  ]}
                  onPress={() => switchAccount(account)}
                >
                  <View style={[styles.userAvatar, { backgroundColor: avatarColor }]}>
                    <Text style={styles.userAvatarText}>
                      {account.displayName?.charAt(0).toUpperCase() || 'U'}
                    </Text>
                  </View>
                  <View style={styles.userInfo}>
                    <Text style={[styles.userName, { color: colors.text }]}>
                      {account.displayName}
                    </Text>
                    <Text style={[styles.userEmail, { color: colors.muted }]}>
                      {account.emailAddress}
                    </Text>
                  </View>
                  {isActive && (
                    <View style={[styles.activeBadge, { backgroundColor: '#3B82F6' }]}>
                      <Text style={styles.activeBadgeText}>Active</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}

            {/* Add Account */}
            <TouchableOpacity
              style={[styles.addAccountButton, { borderColor: colors.divider }]}
              onPress={() => {
                setShowUserModal(false);
                toast.warning('Add account functionality coming soon');
              }}
            >
              <View style={[styles.addAccountIcon, { backgroundColor: '#F3F4F6' }]}>
                <Text style={[styles.addAccountIconText, { color: colors.text }]}>+</Text>
              </View>
              <Text style={[styles.addAccountText, { color: colors.text }]}>Add another account</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const gmailDrawerStyles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 16,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  brandText: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 0.15,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  scrollContent: {
    paddingTop: 8,
    paddingBottom: 8,
  },
  labelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingLeft: 24,
    paddingRight: 24,
    borderTopRightRadius: 28,
    borderBottomRightRadius: 28,
    marginRight: 8,
    gap: 20,
  },
  labelItemActive: {
    backgroundColor: '#FCEAE8',
  },
  labelText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: 0.25,
    color: '#202124',
  },
  labelTextActive: {
    color: '#D93025',
    fontWeight: '700',
  },
  labelCount: {
    fontSize: 12,
    fontWeight: '600',
    color: '#5F6368',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 12,
  },
  accountAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  accountAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  accountInfo: {
    flex: 1,
  },
  accountName: {
    fontSize: 13,
    fontWeight: '600',
  },
  accountEmail: {
    fontSize: 11,
    marginTop: 1,
  },
});

const connectionStyles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    gap: 6,
  },
  bannerText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '500',
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  splitContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  miniSidebar: {
    borderRightWidth: 0.5,
    backgroundColor: '#FAFAFA',
  },
  miniSidebarContent: {
    flex: 1,
    paddingTop: 12,
    paddingBottom: 8,
  },
  miniSidebarItem: {
    alignItems: 'center',
    paddingVertical: 6,
    position: 'relative',
  },
  miniSidebarIconContainer: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
  },
  miniSidebarIconActive: {
    backgroundColor: '#1F2937',
  },
  miniSidebarDivider: {
    height: 0.5,
    marginHorizontal: 12,
    marginVertical: 0,
  },
  emailListPanel: {
    flex: 0,
    borderRightWidth: 0.5,
  },
  emailDetailPanel: {
    flex: 1,
  },
  homeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  homeButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  splitViewBottomBar: {
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 12,
  },
  fabAboveBar: {
    width: 56,
    height: 56,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'flex-end',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  accountSwitchDivider: {
    height: 0.5,
    marginHorizontal: -12,
  },
  accountSwitchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    gap: 10,
  },
  accountSwitchAvatar: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  accountSwitchAvatarText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  accountSwitchInfo: {
    flex: 1,
  },
  accountSwitchName: {
    fontSize: 13,
    fontWeight: '600',
  },
  accountSwitchEmail: {
    fontSize: 11,
    marginTop: 1,
  },
  header: {
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
  menuButton: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  headerTitleCenter: {
    flex: 1,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
    marginLeft: 12,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  accountAvatarButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  accountAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  searchButton: {
    padding: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
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
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E5EA',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  listContainer: {
    paddingBottom: 24,
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    paddingTop: 12,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.2,
  },
  emailItem: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
  },
  emailItemSelected: {
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
  },
  emailRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  emailContent: {
    flex: 1,
    gap: 3,
  },
  emailTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  emailMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '500',
  },
  senderName: {
    fontSize: 14,
    flex: 1,
    marginRight: 8,
  },
  emailTime: {
    fontSize: 12,
  },
  subject: {
    fontSize: 14,
  },
  preview: {
    fontSize: 13,
    lineHeight: 16,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 160,
  },
  emptyIllustrationWrapper: {
    width: 220,
    height: 155,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 0,
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 4,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
  },
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
  },
  drawerContent: {
    flex: 1,
    paddingVertical: 4,
  },
  drawerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 14,
    marginHorizontal: 8,
    borderRadius: 8,
  },
  drawerItemActive: {
    backgroundColor: '#D3E3FD',
  },
  drawerItemText: {
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  drawerItemCount: {
    fontSize: 12,
    fontWeight: '500',
  },
  drawerDivider: {
    height: 0.5,
    marginHorizontal: 12,
    marginVertical: 6,
  },
  drawerAccountSwitcher: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    marginHorizontal: 8,
    marginBottom: 8,
    borderRadius: 8,
  },
  drawerAccountAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  drawerAccountAvatarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  drawerAccountInfo: {
    flex: 1,
  },
  drawerAccountName: {
    fontSize: 14,
    fontWeight: '600',
  },
  drawerAccountEmail: {
    fontSize: 12,
    marginTop: 1,
  },
  drawerFooter: {
    borderTopWidth: 0.5,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  userProfile: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 10,
  },
  userAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userAvatarText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 13,
    fontWeight: '600',
  },
  userEmail: {
    fontSize: 11,
    marginTop: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 4,
    marginRight: 16,
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  userOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    gap: 12,
  },
  activeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  activeBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  addAccountButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: 8,
    gap: 12,
  },
  addAccountIcon: {
    width: 38,
    height: 38,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addAccountIconText: {
    fontSize: 24,
    fontWeight: '300',
  },
  addAccountText: {
    fontSize: 15,
    fontWeight: '500',
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
});
