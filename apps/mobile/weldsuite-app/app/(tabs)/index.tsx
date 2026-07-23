import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View,
  Text,
  ActivityIndicator,
  useWindowDimensions,
  ImageBackground,
  Pressable,
  RefreshControl,
} from 'react-native';
import { haptics } from '@/utils/haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, Pencil } from 'lucide-react-native';
import { AppIcon, APPS_WITH_LOGOS } from '@/components/AppIcon';
import { AppLogoText, hasLogoText } from '@/components/AppLogoText';
import { useTheme } from '@/contexts/ThemeContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { useI18n } from '@weldsuite/i18n/provider';
import { router } from 'expo-router';
import MiniSidebar, { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';

// Background options matching the web platform
const BACKGROUND_IMAGES = [
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?q=80&w=2832&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1505142468610-359e7d316be0?q=80&w=2832&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=2832&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?q=80&w=2832&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1509316785289-025f5b846b35?q=80&w=2832&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?q=80&w=2832&auto=format&fit=crop',
];

// Route mapping for app codes
const routeMap: Record<string, string> = {
  commerce: '/commerce',
  accounting: '/accounting',
  wms: '/wms',
  crm: '/crm',
  projects: '/projects',
  helpdesk: '/helpdesk',
  mail: '/mail',
  parcel: '/parcel',
  task: '/task',
  host: '/host',
  wallet: '/wallet',
  notifications: '/(tabs)/notifications',
};

interface AppCard {
  id: string;
  appCode: string;
  name: string;
  route: string;
}

interface NotificationPreview {
  id: string;
  sender: string;
  subject: string;
  time: Date;
  type: 'email' | 'newsletter' | 'notification';
  avatarColor: string;
}

// Avatar colors for notifications
const AVATAR_COLORS = [
  '#3B82F6', // blue
  '#10B981', // emerald
  '#F59E0B', // amber
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#6366F1', // indigo
  '#F43F5E', // rose
  '#F97316', // orange
];

function getAvatarColor(name: string): string {
  const index = name.charCodeAt(0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// Mock notifications data
const mockNotifications: NotificationPreview[] = [
  {
    id: '1',
    sender: 'Gillian Pachon',
    subject: "It's not magic, it's talent and sweat!",
    time: new Date(new Date().setHours(11, 45, 0, 0)),
    type: 'email',
    avatarColor: getAvatarColor('Gillian Pachon'),
  },
  {
    id: '2',
    sender: 'Lena Campbell',
    subject: 'Runaway Devaluation',
    time: new Date(new Date().setHours(11, 15, 0, 0)),
    type: 'email',
    avatarColor: getAvatarColor('Lena Campbell'),
  },
  {
    id: '3',
    sender: 'Kevin Bateman',
    subject: "Let's discuss the search results",
    time: new Date(new Date().setHours(9, 45, 0, 0)),
    type: 'email',
    avatarColor: getAvatarColor('Kevin Bateman'),
  },
  {
    id: '4',
    sender: 'Tech Weekly',
    subject: 'This week in AI: New breakthroughs',
    time: new Date(new Date().setHours(8, 30, 0, 0)),
    type: 'newsletter',
    avatarColor: getAvatarColor('Tech Weekly'),
  },
  {
    id: '5',
    sender: 'System',
    subject: 'Your invoice #1234 has been paid',
    time: new Date(new Date().setHours(8, 0, 0, 0)),
    type: 'notification',
    avatarColor: getAvatarColor('System'),
  },
];

// iPad Home Screen Component
function IPadHomeScreen({ showSidebar = false }: { showSidebar?: boolean }) {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [backgroundIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
    });
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).toLowerCase();
  };

  const formatNotificationTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).toLowerCase();
  };

  const getGreeting = () => {
    const hour = currentTime.getHours();
    if (hour < 12) return 'Good Morning!';
    if (hour < 18) return 'Good Afternoon!';
    return 'Good Evening!';
  };

  const emailStats = {
    fromPeople: 3,
    newsletters: 12,
    notifications: 2,
  };

  return (
    <View style={styles.iPadContainer}>
      <ImageBackground
        source={{ uri: BACKGROUND_IMAGES[backgroundIndex] }}
        style={styles.backgroundImage}
        resizeMode="cover"
      >
        {/* Dark overlay */}
        <View style={styles.overlay} />

        {/* Glass Sidebar */}
        {showSidebar && (
          <View style={styles.sidebarOverlay}>
            <MiniSidebar currentApp="home" homeRoute="/(tabs)" glass />
          </View>
        )}

        {/* Content */}
        <SafeAreaView style={styles.iPadContent} edges={['top', 'bottom', 'right']}>
          {/* Top Bar */}
          <View style={styles.topBar}>
            {/* Date and Time */}
            <View style={styles.dateTimeContainer}>
              <Text style={styles.dateText}>{formatDate(currentTime)}</Text>
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
            </View>

            {/* Actions */}
            <View style={styles.actionsContainer}>
              <TouchableOpacity style={styles.actionButton}>
                <View style={styles.glassButton}>
                  <Pencil size={18} color="#FFFFFF" strokeWidth={2} />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton}>
                <View style={styles.glassButton}>
                  <Search size={18} color="#FFFFFF" strokeWidth={2} />
                </View>
              </TouchableOpacity>
            </View>
          </View>

          {/* Center Content */}
          <View style={styles.centerContent}>
            <Text style={styles.greetingText}>{getGreeting()}</Text>
            <Text style={styles.subtitleText}>Let's check your Inbox</Text>

            {/* Email Stats Pills */}
            <View style={styles.statsContainer}>
              <TouchableOpacity style={styles.statPill}>
                <View style={styles.statPillGlass}>
                  <Text style={styles.statPillText}>{emailStats.fromPeople} from people</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.statPill}>
                <View style={styles.statPillGlass}>
                  <Text style={styles.statPillText}>{emailStats.newsletters} newsletters</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.statPill}>
                <View style={styles.statPillGlass}>
                  <Text style={styles.statPillText}>{emailStats.notifications} notifications</Text>
                </View>
              </TouchableOpacity>
            </View>

            {/* Notifications Section */}
            <View style={styles.notificationsSection}>
              <Text style={styles.notificationsSectionTitle}>New notifications</Text>

              <View style={styles.notificationsList}>
                {mockNotifications.map((notification, index) => (
                  <Pressable
                    key={notification.id}
                    style={({ pressed }) => [
                      styles.notificationRow,
                      index < mockNotifications.length - 1 && styles.notificationRowBorder,
                      pressed && styles.notificationRowPressed,
                    ]}
                    onPress={() => router.push('/mail' as any)}
                  >
                    {/* Avatar */}
                    <View style={[styles.avatar, { backgroundColor: notification.avatarColor }]}>
                      <Text style={styles.avatarText}>{getInitials(notification.sender)}</Text>
                    </View>

                    {/* Sender */}
                    <Text style={styles.senderText} numberOfLines={1}>
                      {notification.sender}
                    </Text>

                    {/* Subject */}
                    <Text style={styles.subjectText} numberOfLines={1}>
                      {notification.subject}
                    </Text>

                    {/* Time */}
                    <Text style={styles.notificationTime}>
                      {formatNotificationTime(notification.time)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        </SafeAreaView>
      </ImageBackground>
    </View>
  );
}

// Phone Home Screen (original design)
function PhoneHomeScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { installedApps, isLoading, refreshApps } = useInstalledApps();
  const { unreadCount } = useNotifications();
  const [refreshing, setRefreshing] = useState(false);
  const { width } = useWindowDimensions();

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshApps();
    setRefreshing(false);
  }, [refreshApps]);

  // Calculate card width based on screen size
  const getCardWidth = () => {
    const padding = 40;
    const gap = 8;
    const cardsPerRow = 3;
    return (width - padding - (gap * (cardsPerRow - 1))) / cardsPerRow;
  };

  const cardWidth = getCardWidth();

  // Transform installed apps into app cards with routes
  const apps = useMemo(() => {
    return installedApps.map(app => ({
      id: app.id,
      appCode: app.appCode,
      name: app.name,
      route: routeMap[app.appCode] || `/${app.appCode}`,
    }));
  }, [installedApps]);

  const handleAppPress = (app: AppCard) => {
    if (app.route) {
      haptics.light();
      router.push(app.route as any);
    }
  };

  // Filter apps to only show those with custom logos
  const filteredApps = apps.filter(app =>
    APPS_WITH_LOGOS.includes(app.appCode)
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'bottom', 'left']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.text}
          />
        }
      >
        {/* Header */}
        <View style={styles.pageHeader}>
          <Text style={[styles.pageTitle, { color: colors.text }]}>Home</Text>
        </View>

        {/* Apps Grid */}
        <View style={styles.section}>
          {isLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={colors.text} />
              <Text style={[styles.loadingText, { color: colors.muted }]}>{t.common.ui.table.loading}</Text>
            </View>
          ) : filteredApps.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                No apps installed
              </Text>
            </View>
          ) : (
            <View style={styles.appsGrid}>
              {filteredApps.map((app) => {
                // Show notification badge for helpdesk app
                const showBadge = app.appCode === 'helpdesk' && unreadCount > 0;
                return (
                  <TouchableOpacity
                    key={app.id}
                    activeOpacity={0.6}
                    delayPressIn={0}
                    style={[
                      styles.appCard,
                      {
                        backgroundColor: '#F3F4F6',
                        width: cardWidth,
                        height: cardWidth * 0.75,
                      },
                    ]}
                    onPress={() => handleAppPress(app)}
                  >
                    <View style={styles.appIconWrapper}>
                      <AppIcon appCode={app.appCode} size={24} />
                      {showBadge && (
                        <View style={styles.notificationBadge}>
                          <Text style={styles.notificationBadgeText}>
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </Text>
                        </View>
                      )}
                    </View>
                    {hasLogoText(app.appCode) ? (
                      <AppLogoText appCode={app.appCode} height={11} color="#111827" />
                    ) : (
                      <Text style={[styles.appName, { color: '#111827' }]}>
                        {app.name}
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function HomeScreen() {
  const showMiniSidebar = useShouldShowMiniSidebar();

  // Show iPad design on tablets - sidebar overlays the background
  if (showMiniSidebar) {
    return <IPadHomeScreen showSidebar />;
  }

  // Show phone design on smaller screens
  return <PhoneHomeScreen />;
}

const styles = StyleSheet.create({
  // Container styles
  sidebarContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebarContent: {
    flex: 1,
  },
  sidebarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    zIndex: 10,
  },
  container: {
    flex: 1,
  },

  // iPad styles
  iPadContainer: {
    flex: 1,
  },
  backgroundImage: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  iPadContent: {
    flex: 1,
    paddingLeft: 64, // Account for glass sidebar width
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 32,
    paddingTop: 16,
  },
  dateTimeContainer: {
    alignItems: 'flex-start',
  },
  dateText: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.8)',
    letterSpacing: 0.5,
  },
  timeText: {
    fontSize: 48,
    fontWeight: '300',
    color: '#FFFFFF',
    marginTop: 4,
    letterSpacing: -1,
  },
  actionsContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  glassButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  greetingText: {
    fontSize: 56,
    fontWeight: '500',
    color: '#FFFFFF',
    textAlign: 'center',
    letterSpacing: -1,
  },
  subtitleText: {
    fontSize: 56,
    fontWeight: '300',
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
    marginBottom: 24,
    letterSpacing: -1,
  },
  statsContainer: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  statPill: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  statPillGlass: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  statPillText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  notificationsSection: {
    width: '100%',
    maxWidth: 600,
    marginTop: 48,
  },
  notificationsSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.6)',
    textTransform: 'uppercase',
    letterSpacing: 1,
    textAlign: 'center',
    marginBottom: 12,
  },
  notificationsList: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  notificationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  notificationRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  notificationRowPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  avatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  senderText: {
    width: 130,
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  subjectText: {
    flex: 1,
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.6)',
    marginLeft: 24,
  },
  notificationTime: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.4)',
    marginLeft: 8,
  },

  // Phone styles (original)
  pageHeader: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 10,
  },
  pageTitle: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  section: {
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  appsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  appCard: {
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 6,
  },
  appIconWrapper: {
    marginBottom: 10,
    position: 'relative',
  },
  notificationBadge: {
    position: 'absolute',
    top: -6,
    right: -10,
    backgroundColor: '#EF4444',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  appName: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
  },
  emptyContainer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
  },
});
