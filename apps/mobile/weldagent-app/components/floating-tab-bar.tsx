/**
 * WeldAgent floating tab bar - shared chrome + new-chat accent.
 */

import { Sparkles } from 'lucide-react-native';

import { FloatingTabBar as SharedFloatingTabBar, type FloatingTabBarProps } from '@weldsuite/mobile-ui/components/FloatingTabBar';

import { BRAND } from '@/lib/brand';

export {
  FLOATING_TAB_BAR_HEIGHT,
  FLOATING_TAB_BAR_MARGIN,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@weldsuite/mobile-ui/components/FloatingTabBar';

export function FloatingTabBar(props: Readonly<FloatingTabBarProps>) {
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
