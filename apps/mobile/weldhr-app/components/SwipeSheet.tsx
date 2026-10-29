/**
 * A bottom sheet that sizes to what it holds, after Shiftbase's: white with
 * rounded top corners and a grabber, over the page dimmed behind it. Drag it
 * down from anywhere on it (or flick it) or tap the dimmed page to close it.
 * `close`, handed to the children, slides it away before `onClose` runs.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from '@/hooks/use-palette';

const OPEN = { duration: 320, easing: Easing.bezier(0.2, 0.9, 0.3, 1) };
const CLOSE = { duration: 220, easing: Easing.bezier(0.4, 0, 1, 1) };
const SPRING_BACK = { damping: 22, stiffness: 260 };
/** A drag past this share of the sheet's height, or a flick faster than this, closes it. */
const CLOSE_SHARE = 0.3;
const CLOSE_VELOCITY = 800;

export function SwipeSheet({
  onClose,
  children,
}: Readonly<{
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}>) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  // Below the screen until the sheet has measured itself and slides up.
  const offset = useSharedValue(screenHeight);
  const sheetHeight = useSharedValue(screenHeight);

  useEffect(() => {
    if (height === 0) return;
    sheetHeight.value = height;
    offset.value = withTiming(0, OPEN);
  }, [height, offset, sheetHeight]);

  const close = () => {
    offset.value = withTiming(sheetHeight.value, CLOSE, (finished) => {
      if (finished) scheduleOnRN(onClose);
    });
  };

  // Only a drag downwards takes over, so taps and the switches inside still work.
  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-20, 20])
    .onUpdate((event) => {
      offset.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (event.velocityY > CLOSE_VELOCITY || offset.value > sheetHeight.value * CLOSE_SHARE) {
        offset.value = withTiming(sheetHeight.value, CLOSE, (finished) => {
          if (finished) scheduleOnRN(onClose);
        });
      } else {
        offset.value = withSpring(0, SPRING_BACK);
      }
    });

  // Slid by its bottom edge, not a transform: under a transform the native
  // views inside (the switches) are drawn half their height above their place.
  const sheetStyle = useAnimatedStyle(() => ({ bottom: -offset.value }));
  const dimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [0, sheetHeight.value], [1, 0], 'clamp'),
  }));

  const onLayout = (event: LayoutChangeEvent) => setHeight(Math.round(event.nativeEvent.layout.height));

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={close}>
      {/* A Modal is its own native window: gestures in it need their own root. */}
      <GestureHandlerRootView style={styles.flex}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]}>
          <Pressable style={styles.flex} onPress={close} accessibilityRole="button" />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            onLayout={onLayout}
            style={[
              styles.sheet,
              { backgroundColor: palette.surface, paddingBottom: Math.max(insets.bottom, 16) + 8 },
              sheetStyle,
            ]}
          >
            <View style={styles.grabberZone}>
              <View style={[styles.grabber, { backgroundColor: palette.grabber }]} />
            </View>
            {children(close)}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  dim: { backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderCurve: 'continuous',
  },
  grabberZone: { alignItems: 'center', paddingTop: 8, paddingBottom: 14 },
  grabber: { width: 40, height: 5, borderRadius: 2.5 },
});
