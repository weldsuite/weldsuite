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
  type StyleProp,
  type ViewStyle,
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

/** A tab hidden with Expo Router's `href: null` (or an explicit display: none). */
function isHiddenTab(itemStyle: StyleProp<ViewStyle>): boolean {
  return StyleSheet.flatten(itemStyle)?.display === 'none';
}

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
        /** Forwarded to the tab button (e2e selectors). */
        tabBarButtonTestID?: string;
        /** Expo Router sets `{ display: 'none' }` for a tab with `href: null`. */
        tabBarItemStyle?: StyleProp<ViewStyle>;
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
  /**
   * The bar's fill. Defaults to a near-opaque white / dark grey; an app whose
   * content scrolls under the bar passes a solid colour so nothing shows through.
   */
  shellColor?: string;
  /** Hairline around the bar (defaults to a faint black/white). */
  borderColor?: string;
  /** A light shadow all round, so the bar stands out on a white page. Off by default. */
  shadow?: boolean;
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
  shellColor,
  borderColor,
  shadow = false,
}: Readonly<FloatingTabBarProps>) {
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
    shellColor ?? (theme === 'dark' ? 'rgba(28, 28, 30, 0.92)' : 'rgba(255, 255, 255, 0.94)');
  const shellBorder =
    borderColor ?? (theme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)');
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
      {/* The shadow sits on a box of its own: the shell clips its corners, and that would clip a shadow too. */}
      <View style={[styles.lift, shadow && [styles.shadow, { backgroundColor: shellBackground }]]}>
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
            if (isHiddenTab(options.tabBarItemStyle)) return null;
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

            let color = colors.muted;
            if (isFocused) {
              color = isAccent ? (accentColor ?? colors.text) : colors.text;
            }

            const iconSize = isAccent ? 24 : 22;

            return (
              <Pressable
                key={route.key}
                accessibilityRole="button"
                accessibilityState={isFocused ? { selected: true } : {}}
                accessibilityLabel={options.tabBarAccessibilityLabel ?? options.title}
                testID={options.tabBarButtonTestID}
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
                  <Badge
                    label={typeof badge === 'number' && badge > 99 ? '99+' : String(badge)}
                    color={badgeColor}
                    // The ring is what lies behind the badge: the shell, and on the
                    // chosen tab the indicator over it.
                    ring={shellBackground}
                    ringOverlay={isFocused ? indicatorBackground : undefined}
                  />
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
    </View>
  );
}

/** The count's dot: one digit fits a circle of this size; more make it a pill. */
const BADGE_SIZE = 18;
/** The ring around it, in the colour behind, that cuts it out of the icon. */
const BADGE_RING = 2;

/**
 * A count on a tab's icon: a perfect circle (a pill from two characters) on
 * the icon's top-right corner, cut out of the icon by a ring in the colour
 * behind it, so it reads on the plain bar and on the chosen tab's pill alike.
 */
function Badge({
  label,
  color,
  ring,
  ringOverlay,
}: {
  label: string;
  color: string;
  ring: string;
  ringOverlay?: string;
}) {
  return (
    <View style={[styles.badgeRing, { backgroundColor: ring }]} pointerEvents="none">
      {ringOverlay ? <View style={[StyleSheet.absoluteFill, { backgroundColor: ringOverlay }]} /> : null}
      <View style={[styles.badge, label.length > 1 && styles.badgeWide, { backgroundColor: color }]}>
        <Text style={styles.badgeText} numberOfLines={1} allowFontScaling={false}>
          {label}
        </Text>
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
  lift: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 28,
  },
  shadow: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: {
        elevation: 6,
      },
    }),
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
  // Its left edge just right of the icon's middle, so it sits on the icon's
  // top-right corner whatever the tab's width (a 22pt icon in the 56pt bar).
  badgeRing: {
    position: 'absolute',
    top: 8,
    left: '50%',
    marginLeft: 2,
    padding: BADGE_RING,
    borderRadius: BADGE_SIZE / 2 + BADGE_RING,
    overflow: 'hidden',
  },
  badge: {
    minWidth: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeWide: { paddingHorizontal: 5 },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
});
