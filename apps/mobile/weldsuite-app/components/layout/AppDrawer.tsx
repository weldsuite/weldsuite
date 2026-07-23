import React, { useCallback } from 'react';
import { StyleSheet, View, Text, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Settings, Plus } from 'lucide-react-native';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { AppIcon, APPS_WITH_LOGOS } from '@/components/AppIcon';
import { Gesture, GestureDetector, RectButton } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';

const DRAWER_WIDTH = 320;
const SPRING_CONFIG = { damping: 25, stiffness: 200 };

const APP_CONFIG: Record<string, { route: string }> = {
  mail: { route: '/mail' },
  crm: { route: '/crm' },
  helpdesk: { route: '/helpdesk' },
  projects: { route: '/projects' },
  task: { route: '/task' },
  host: { route: '/host' },
};

export interface DrawerMenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  badge?: number;
}

interface AppDrawerProps {
  visible: boolean;
  onClose: () => void;
  currentApp: string;
  menuItems: DrawerMenuItem[];
  activeMenuItem?: string;
}

export function useAppDrawer() {
  const [visible, setVisible] = React.useState(false);

  const open = useCallback(() => {
    setVisible(true);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
  }, []);

  return { visible, open, close };
}

export default function AppDrawer({ visible, onClose, currentApp, menuItems, activeMenuItem }: AppDrawerProps) {
  const insets = useSafeAreaInsets();
  const { installedApps } = useInstalledApps();
  const { unreadCount } = useNotifications();

  // Shared value: 0 = closed, DRAWER_WIDTH = fully open
  const translateX = useSharedValue(-DRAWER_WIDTH);
  const wasSwiping = React.useRef(false);

  React.useEffect(() => {
    if (visible) {
      translateX.value = withSpring(0, SPRING_CONFIG);
    }
  }, [visible]);

  const doClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const scrollNativeGesture = React.useMemo(() => Gesture.Native(), []);

  const markSwiping = useCallback(() => { wasSwiping.current = true; }, []);
  const clearSwiping = useCallback(() => {
    setTimeout(() => { wasSwiping.current = false; }, 200);
  }, []);
  const safePress = useCallback((fn: () => void) => () => {
    if (wasSwiping.current) return;
    fn();
  }, []);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .simultaneousWithExternalGesture(scrollNativeGesture)
    .onStart(() => {
      runOnJS(markSwiping)();
    })
    .onUpdate((e) => {
      translateX.value = Math.min(0, Math.max(-DRAWER_WIDTH, e.translationX));
    })
    .onEnd((e) => {
      runOnJS(clearSwiping)();
      const shouldClose = e.velocityX < -300 || translateX.value < -DRAWER_WIDTH * 0.3;
      if (shouldClose) {
        translateX.value = withSpring(-DRAWER_WIDTH, SPRING_CONFIG, (finished) => {
          if (finished) runOnJS(doClose)();
        });
      } else {
        translateX.value = withSpring(0, SPRING_CONFIG);
      }
    })
    .onFinalize(() => {
      runOnJS(clearSwiping)();
    });

  const overlayTap = Gesture.Tap().onEnd(() => {
    translateX.value = withSpring(-DRAWER_WIDTH, SPRING_CONFIG, (finished) => {
      if (finished) runOnJS(doClose)();
    });
  });

  const composedGesture = Gesture.Race(panGesture, overlayTap);

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: (translateX.value + DRAWER_WIDTH) / DRAWER_WIDTH * 0.4,
  }));

  const handleClose = useCallback(() => {
    translateX.value = withSpring(-DRAWER_WIDTH, SPRING_CONFIG, (finished) => {
      if (finished) runOnJS(doClose)();
    });
  }, [doClose]);

  const apps = installedApps
    .filter(app => APP_CONFIG[app.appCode] && APPS_WITH_LOGOS.includes(app.appCode))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={handleClose}>
      <GestureDetector gesture={composedGesture}>
        <View style={StyleSheet.absoluteFill}>
          {/* Overlay */}
          <Animated.View style={[styles.overlay, overlayStyle]} />

          {/* Drawer */}
          <Animated.View style={[styles.drawer, drawerStyle]}>
            <View style={styles.drawerInner}>
              {/* Top bar — app icons */}
              <View style={[styles.miniBar, { paddingTop: insets.top + 8 }]}>
                <Animated.ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.miniBarContent}
                >
                  {apps.map(app => {
                    const isActive = app.appCode === currentApp;
                    const showBadge = app.appCode === 'helpdesk' && unreadCount > 0;

                    return (
                      <RectButton
                        key={app.id}
                        style={styles.miniItem}
                        onPress={safePress(() => {
                          if (!isActive) {
                            handleClose();
                            setTimeout(() => router.replace(APP_CONFIG[app.appCode].route as any), 250);
                          }
                        })}
                        rippleColor="rgba(0,0,0,0.08)"
                      >
                        <View style={[styles.miniIconContainer, isActive && styles.miniIconActive]}>
                          <AppIcon appCode={app.appCode} size={24} />
                          {showBadge && (
                            <View style={styles.badge}>
                              <Text style={styles.badgeText}>
                                {unreadCount > 99 ? '99+' : unreadCount}
                              </Text>
                            </View>
                          )}
                        </View>
                      </RectButton>
                    );
                  })}
                </Animated.ScrollView>
              </View>

              {/* Main panel — pages within current app */}
              <View style={styles.mainPanel}>
                <GestureDetector gesture={scrollNativeGesture}>
                <Animated.ScrollView
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.mainContent}
                >
                  {menuItems.map(item => {
                    const isActive = activeMenuItem === item.key;
                    return (
                      <RectButton
                        key={item.key}
                        style={[styles.menuItem, isActive && styles.menuItemActive]}
                        onPress={safePress(() => {
                          item.onPress();
                          handleClose();
                        })}
                        rippleColor="rgba(0,0,0,0.08)"
                      >
                        <View style={styles.menuItemIcon}>{item.icon}</View>
                        <Text
                          style={[
                            styles.menuItemText,
                            isActive && styles.menuItemTextActive,
                          ]}
                        >
                          {item.label}
                        </Text>
                        {item.badge != null && item.badge > 0 && (
                          <View style={styles.menuBadge}>
                            <Text style={styles.menuBadgeText}>{item.badge}</Text>
                          </View>
                        )}
                      </RectButton>
                    );
                  })}
                </Animated.ScrollView>
                </GestureDetector>
              </View>

              {/* Bottom actions */}
              <View style={[styles.bottomActions, { paddingBottom: insets.bottom + 8 }]}>
                <RectButton
                  style={styles.bottomActionItem}
                  onPress={safePress(() => {
                    handleClose();
                    setTimeout(() => router.push('/settings' as any), 250);
                  })}
                  rippleColor="rgba(0,0,0,0.08)"
                >
                  <Settings size={20} color="#9CA3AF" strokeWidth={2} />
                  <Text style={styles.bottomActionText}>Settings</Text>
                </RectButton>
                <RectButton
                  style={styles.bottomActionItem}
                  onPress={safePress(() => {
                    handleClose();
                    setTimeout(() => router.push('/app-store' as any), 250);
                  })}
                  rippleColor="rgba(0,0,0,0.08)"
                >
                  <Plus size={20} color="#9CA3AF" strokeWidth={2} />
                  <Text style={styles.bottomActionText}>App Store</Text>
                </RectButton>
              </View>
            </View>
          </Animated.View>
        </View>
      </GestureDetector>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  drawerInner: {
    flex: 1,
    flexDirection: 'column',
  },
  miniBar: {
    backgroundColor: '#F9FAFB',
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
    paddingBottom: 8,
  },
  miniBarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 2,
  },
  miniItem: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  miniIconContainer: {
    width: 46,
    height: 46,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    position: 'relative',
  },
  miniIconActive: {
    backgroundColor: '#1F2937',
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: '#EF4444',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '700',
  },
  mainPanel: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  bottomActions: {
    borderTopWidth: 0.5,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  bottomActionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  bottomActionText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#9CA3AF',
  },
  mainContent: {
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    gap: 14,
  },
  menuItemActive: {
    backgroundColor: '#E5E7EB',
  },
  menuItemIcon: {
    width: 24,
    alignItems: 'center',
  },
  menuItemText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: '#374151',
  },
  menuItemTextActive: {
    fontWeight: '600',
    color: '#111827',
  },
  menuBadge: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
});
