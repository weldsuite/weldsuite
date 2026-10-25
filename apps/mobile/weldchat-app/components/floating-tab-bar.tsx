/**
 * WeldChat floating tab bar - shared chrome + brand badge colour and a slightly
 * stronger border.
 */

import { FloatingTabBar as SharedFloatingTabBar, type FloatingTabBarProps } from '@weldsuite/mobile-ui/components/FloatingTabBar';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/lib/brand';

export {
  FLOATING_TAB_BAR_HEIGHT,
  FLOATING_TAB_BAR_MARGIN,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@weldsuite/mobile-ui/components/FloatingTabBar';

export function FloatingTabBar(props: Readonly<FloatingTabBarProps>) {
  const { theme } = useTheme();
  // Clearly more visible than the shared default.
  const borderColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.16)';
  return <SharedFloatingTabBar {...props} badgeColor={BRAND} borderColor={borderColor} />;
}
