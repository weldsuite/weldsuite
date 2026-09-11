/**
 * WeldAgent floating tab bar — shared chrome + new-chat accent.
 */

import { Sparkles } from 'lucide-react-native';

import {
  FloatingTabBar as SharedFloatingTabBar,
  FLOATING_TAB_BAR_HEIGHT,
  FLOATING_TAB_BAR_MARGIN,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@weldsuite/mobile-ui/components/FloatingTabBar';

import { BRAND } from '@/lib/brand';

export {
  FLOATING_TAB_BAR_HEIGHT,
  FLOATING_TAB_BAR_MARGIN,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
};

export function FloatingTabBar(props: FloatingTabBarProps) {
  return (
    <SharedFloatingTabBar
      {...props}
      accentRouteName="new-placeholder"
      accentColor={BRAND}
      renderAccentFallbackIcon={({ color, size }) => (
        <Sparkles size={size} color={color} strokeWidth={2.2} />
      )}
    />
  );
}
