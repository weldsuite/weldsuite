import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { Home, PanelLeftClose } from 'lucide-react-native';
import { AppIcon, APPS_WITH_LOGOS } from '@/components/AppIcon';

// Minimum width to show mini sidebar (iPad portrait and larger)
const SPLIT_VIEW_MIN_WIDTH = 768;
export const MINI_SIDEBAR_WIDTH = 64;

// Map app codes to routes (only apps with custom logos)
const APP_CONFIG: Record<string, { route: string; color: string }> = {
  mail: { route: '/mail', color: '#3B82F6' },
  crm: { route: '/crm', color: '#8B5CF6' },
  helpdesk: { route: '/helpdesk', color: '#EC4899' },
  projects: { route: '/projects', color: '#06B6D4' },
  task: { route: '/task', color: '#EF4444' },
  host: { route: '/host', color: '#6366F1' },
};

interface MiniSidebarProps {
  currentApp: string;
  onCollapse?: () => void;
  homeRoute?: string;
  skipTopPadding?: boolean;
  glass?: boolean;
}

export function useShouldShowMiniSidebar() {
  const { width } = useWindowDimensions();
  return width >= SPLIT_VIEW_MIN_WIDTH;
}

export default function MiniSidebar({ currentApp, onCollapse, homeRoute = '/(tabs)', skipTopPadding = false, glass = false }: MiniSidebarProps) {
  const insets = useSafeAreaInsets();
  const { installedApps } = useInstalledApps();
  const { unreadCount } = useNotifications();
  const { width } = useWindowDimensions();

  // Don't render on small screens
  if (width < SPLIT_VIEW_MIN_WIDTH) {
    return null;
  }

  const isHomeActive = currentApp === 'home';

  const content = (
    <>
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Home Button */}
        <TouchableOpacity
          style={styles.item}
          onPress={() => {
            if (!isHomeActive) {
              router.replace(homeRoute as any);
            }
          }}
        >
          <View style={[
            styles.iconContainer,
            isHomeActive && (glass ? styles.iconActiveGlass : styles.iconActive)
          ]}>
            <Home size={24} color={isHomeActive ? '#FFFFFF' : (glass ? 'rgba(255,255,255,0.85)' : '#6B7280')} strokeWidth={2} />
          </View>
        </TouchableOpacity>

        {/* Installed Apps */}
        {installedApps
          .filter(app => APP_CONFIG[app.appCode] && APPS_WITH_LOGOS.includes(app.appCode))
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map(app => {
            const config = APP_CONFIG[app.appCode];
            const isActive = app.appCode === currentApp;
            // Show notification badge for helpdesk app
            const showBadge = app.appCode === 'helpdesk' && unreadCount > 0;

            return (
              <TouchableOpacity
                key={app.id}
                style={styles.item}
                onPress={() => {
                  if (!isActive) {
                    router.replace(config.route as any);
                  }
                }}
              >
                <View style={[
                  styles.iconContainer,
                  isActive && (glass ? styles.iconActiveGlass : styles.iconActive)
                ]}>
                  <AppIcon appCode={app.appCode} size={24} />
                  {showBadge && (
                    <View style={styles.notificationBadge}>
                      <Text style={styles.notificationBadgeText}>
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
      </ScrollView>

      {/* Collapse Button */}
      {onCollapse && (
        <View style={[styles.bottomSection, { paddingBottom: insets.bottom + 8 }]}>
          <TouchableOpacity style={styles.item} onPress={onCollapse}>
            <View style={styles.iconContainer}>
              <PanelLeftClose size={22} color={glass ? 'rgba(255,255,255,0.7)' : '#6B7280'} strokeWidth={2} />
            </View>
          </TouchableOpacity>
        </View>
      )}
    </>
  );

  return (
    <View style={[
      styles.container,
      !skipTopPadding && { paddingTop: insets.top },
      glass && styles.containerGlass,
    ]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: MINI_SIDEBAR_WIDTH,
    borderRightWidth: 1,
    borderRightColor: '#E5E7EB',
    backgroundColor: '#FAFAFA',
  },
  containerGlass: {
    flex: 1,
    backgroundColor: 'transparent',
    borderRightColor: 'rgba(255, 255, 255, 0.15)',
  },
  content: {
    flex: 1,
    paddingTop: 0,
    paddingBottom: 8,
  },
  item: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  iconContainer: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    position: 'relative',
  },
  notificationBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: '#EF4444',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  iconActive: {
    backgroundColor: '#1F2937',
  },
  iconActiveGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  divider: {
    height: 0.5,
    marginHorizontal: 12,
    marginVertical: 0,
    backgroundColor: '#E5E7EB',
  },
  dividerGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  bottomSection: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingTop: 8,
  },
});
