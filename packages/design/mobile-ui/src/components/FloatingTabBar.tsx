/**
 * Floating pill tab bar - icon-only, no labels.
 *
 * Translucent bar above the home indicator with a spring-animated active
 * highlight. Indicator layouts are kept in a React ref (not a shared-value
 * object spread) so rapid tab switches cannot leave the pill stuck on a
 * previous route.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../contexts/ThemeContext';
import {
  resolveIndicatorLayout,
  shouldMoveIndicatorForLayout,
  upsertTabLayout,
  type TabLayout,
} from '../utils/floatingTabBarState';

export const FLOATING_TAB_BAR_HEIGHT = 56;
export const FLOATING_TAB_BAR_MARGIN = 12;

/** Total vertical space tab screens should reserve beneath scroll content. */
export function floatingTabBarBottomInset(safeAreaBottom = 0): number {
  return FLOATING_TAB_BAR_HEIGHT + FLOATING_TAB_BAR_MARGIN + safeAreaBottom;
}

/**
 * Screen options for Expo Router / React Navigation when using this bar.
 * Positions the host tab-bar slot over the scene so absolute chrome and
 * hit-testing stay aligned.
 */
export const floatingTabBarScreenOptions = {
  tabBarStyle: {
    position: 'absolute' as const,
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    elevation: 0,
  },
};

const SPRING = { damping: 22, stiffness: 280, mass: 0.6 };

type TabBarIconProps = { focused: boolean; color: string; size: number };

export interface FloatingTabBarProps {
  state: {
    index: number;
    routes: { key: string; name: string; params?: object }[];
  };
  descriptors: Record<
    string,
    {
      options: {
        title?: string;
        tabBarAccessibilityLabel?: string;
        tabBarBadge?: string | number;
        tabBarIcon?: (props: TabBarIconProps) => ReactNode;
      };
    }
  >;
  navigation: {
    emit: (event: {
      type: string;
      target: string;
      canPreventDefault?: boolean;
    }) => { defaultPrevented: boolean };
    navigate: (name: string, params?: object) => void;
    /** Prefer jumpTo when available - more reliable for sibling tab switches. */
    jumpTo?: (name: string, params?: object) => void;
  };
  /** Route name that uses accentColor when focused (e.g. center action tab). */
  accentRouteName?: string;
  accentColor?: string;
  /** Extra chrome on a tab (offline-queue dot, etc.). */
  renderRouteAccessory?: (route: {
    name: string;
    key: string;
    index: number;
    focused: boolean;
  }) => ReactNode;
  /** Fallback when options.tabBarIcon is missing (accent route only). */
  renderAccentFallbackIcon?: (props: TabBarIconProps) => ReactNode;
  /** Background for options.tabBarBadge (defaults to destructive red). */
  badgeColor?: string;
}

export function FloatingTabBar({
  state,
  descriptors,
  navigation,
  accentRouteName,
  accentColor,
  renderRouteAccessory,
  renderAccentFallbackIcon,
  badgeColor = '#EF4444',
}: FloatingTabBarProps) {
  const { colors, theme } = useTheme();
  const insets = useSafeAreaInsets();

  const indicatorX = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const layoutsRef = useRef<Record<number, TabLayout>>({});
  const activeIndexRef = useRef(state.index);

  const activeIndex = state.index;
  activeIndexRef.current = activeIndex;

  const moveIndicator = (layout: TabLayout, animated: boolean) => {
    if (animated) {
      indicatorX.value = withSpring(layout.x, SPRING);
      indicatorWidth.value = withSpring(layout.width, SPRING);
    } else {
      indicatorX.value = layout.x;
      indicatorWidth.value = layout.width;
    }
  };

  useEffect(() => {
    const layout = resolveIndicatorLayout(layoutsRef.current, activeIndex);
    if (layout) {
      moveIndicator(layout, true);
    }
    // indicator shared values are stable; moveIndicator closes over them.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only re-run on tab index change
  }, [activeIndex]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorWidth.value,
  }));

  const shellBackground =
    theme === 'dark' ? 'rgba(28, 28, 30, 0.92)' : 'rgba(255, 255, 255, 0.94)';
  const shellBorder =
    theme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';
  const indicatorBackground =
    theme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.06)';

  const onTabLayout = (index: number) => (event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    const prev = layoutsRef.current[index];
    upsertTabLayout(layoutsRef.current, index, { x, width });

    if (shouldMoveIndicatorForLayout(index, activeIndexRef.current)) {
      // First measurement for this tab: snap. Later resizes: spring.
      moveIndicator({ x, width }, prev != null);
    }
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrapper, { paddingBottom: Math.max(insets.bottom, 8) }]}
    >
      <View
        style={[
          styles.shell,
          {
            backgroundColor: shellBackground,
            borderColor: shellBorder,
          },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            { backgroundColor: indicatorBackground },
            indicatorStyle,
          ]}
        />

        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const isFocused = state.index === index;
          const isAccent = accentRouteName != null && route.name === accentRouteName;
          const badge = options.tabBarBadge;

          const onPress = () => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              if (navigation.jumpTo) {
                navigation.jumpTo(route.name, route.params);
              } else {
                navigation.navigate(route.name, route.params);
              }
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          const color = isAccent
            ? isFocused
              ? (accentColor ?? colors.text)
              : colors.muted
            : isFocused
              ? colors.text
              : colors.muted;

          const iconSize = isAccent ? 24 : 22;

          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? options.title}
              onPress={onPress}
              onLongPress={onLongPress}
              onLayout={onTabLayout(index)}
              style={styles.tab}
            >
              {options.tabBarIcon?.({
                focused: isFocused,
                color,
                size: iconSize,
              }) ??
                (isAccent
                  ? renderAccentFallbackIcon?.({
                      focused: isFocused,
                      color,
                      size: iconSize,
                    })
                  : null)}
              {badge != null && badge !== 0 ? (
                <View style={[styles.badge, { backgroundColor: badgeColor }]}>
                  <Text style={styles.badgeText}>
                    {typeof badge === 'number' && badge > 99 ? '99+' : String(badge)}
                  </Text>
                </View>
              ) : null}
              {renderRouteAccessory?.({
                name: route.name,
                key: route.key,
                index,
                focused: isFocused,
              })}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  shell: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    maxWidth: 420,
    height: FLOATING_TAB_BAR_HEIGHT,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.18,
        shadowRadius: 16,
      },
      android: {
        elevation: 12,
      },
    }),
  },
  indicator: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    left: 0,
    borderRadius: 20,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minWidth: 44,
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: '18%',
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 11,
  },
});
