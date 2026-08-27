/**
 * Floating pill tab bar — icon-only, no labels.
 * Same chrome as WeldBooks: translucent bar above the home indicator.
 */

import { useEffect, type ReactNode } from 'react';
import {
  View,
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

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

export const FLOATING_TAB_BAR_HEIGHT = 56;
export const FLOATING_TAB_BAR_MARGIN = 12;

export function floatingTabBarBottomInset(safeAreaBottom = 0): number {
  return FLOATING_TAB_BAR_HEIGHT + FLOATING_TAB_BAR_MARGIN + safeAreaBottom;
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
  };
}

export function FloatingTabBar({ state, descriptors, navigation }: FloatingTabBarProps) {
  const { colors, theme } = useTheme();
  const insets = useSafeAreaInsets();

  const indicatorX = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const tabLayouts = useSharedValue<Record<number, { x: number; width: number }>>({});

  const activeIndex = state.index;

  useEffect(() => {
    const layout = tabLayouts.value[activeIndex];
    if (layout) {
      indicatorX.value = withSpring(layout.x, SPRING);
      indicatorWidth.value = withSpring(layout.width, SPRING);
    }
  }, [activeIndex, indicatorX, indicatorWidth, tabLayouts]);

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
    tabLayouts.value = { ...tabLayouts.value, [index]: { x, width } };
    if (index === activeIndex) {
      indicatorX.value = withSpring(x, SPRING);
      indicatorWidth.value = withSpring(width, SPRING);
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

          const onPress = () => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          const color = isFocused ? colors.text : colors.muted;

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
                size: 22,
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
    borderRadius: 20,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minWidth: 44,
  },
});
