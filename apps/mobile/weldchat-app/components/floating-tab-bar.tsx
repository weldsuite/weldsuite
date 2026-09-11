/**
 * WeldChat floating tab bar — shared chrome + brand badge colour.
 */

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
  return <SharedFloatingTabBar {...props} badgeColor={BRAND} />;
}
