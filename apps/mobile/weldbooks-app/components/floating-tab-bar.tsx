/**
 * WeldBooks floating tab bar - shared chrome + scan accent + offline queue dot.
 */

import { View, StyleSheet } from 'react-native';
import { Camera } from 'lucide-react-native';

import {
  FloatingTabBar as SharedFloatingTabBar,
  FLOATING_TAB_BAR_HEIGHT,
  FLOATING_TAB_BAR_MARGIN,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@weldsuite/mobile-ui/components/FloatingTabBar';

import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import { BRAND } from '@/lib/brand';

export {
  FLOATING_TAB_BAR_HEIGHT,
  FLOATING_TAB_BAR_MARGIN,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
};

export function FloatingTabBar(props: FloatingTabBarProps) {
  const { queue } = useOfflineQueue();

  return (
    <SharedFloatingTabBar
      {...props}
      accentRouteName="scan-placeholder"
      accentColor={BRAND}
      renderAccentFallbackIcon={({ color, size }) => (
        <Camera size={size} color={color} strokeWidth={2.2} />
      )}
      renderRouteAccessory={({ name }) =>
        name === 'scan-placeholder' && queue.length > 0 ? (
          <View style={styles.scanBadge}>
            <View style={styles.scanBadgeDot} />
          </View>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  scanBadge: {
    position: 'absolute',
    top: 10,
    right: '22%',
  },
  scanBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
});
