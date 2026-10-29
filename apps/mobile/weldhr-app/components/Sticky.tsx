/**
 * Sticky section headers, the way iOS lists do them. While a list scrolls,
 * the header of the section at the top stays at the top; the next section's
 * header slides up under it, pushes it out and takes its place.
 *
 * Each header stays in its own section and is moved down by a transform
 * worked out on the UI thread from the scroll position, so nothing waits for
 * React: there is no copy to swap in, the header that leaves keeps sliding
 * until it is off the screen, and the one that arrives is already in place.
 *
 * `Screen` owns the scroll view and provides the scroll position; a list
 * measures its sections with `useStickySections`, wraps each one in
 * `StickySection` (a direct child of the screen's content) and its header in
 * `StickyHeader`.
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

interface StickyScroll {
  /** The scroll view's content offset. */
  scrollY: SharedValue<number>;
}

export const StickyScrollContext = createContext<StickyScroll | null>(null);

export interface StickySections {
  count: number;
  /** How far apart the tops of two headers are while one pushes the other out. */
  stack: number;
  scrollY: SharedValue<number>;
  /** Each section's top and height in the scroll content. */
  tops: SharedValue<number[]>;
  heights: SharedValue<number[]>;
  /** Each section's header height. */
  headers: SharedValue<number[]>;
  measure: (kind: 'section' | 'header', index: number) => (event: LayoutChangeEvent) => void;
}

/**
 * The measurements `count` sections' headers ride on. `stack` is how far
 * below a leaving header's top the arriving one's top sits when it starts
 * to push: the header text's height plus a small gap, so the two lines stack
 * close together and slide away as one.
 */
export function useStickySections(count: number, stack: number): StickySections {
  const scroll = useContext(StickyScrollContext);
  const fallback = useSharedValue(0);
  const tops = useSharedValue<number[]>([]);
  const heights = useSharedValue<number[]>([]);
  const headers = useSharedValue<number[]>([]);
  const layouts = useRef({ tops: [] as number[], heights: [] as number[], headers: [] as number[] });

  // A week with fewer days leaves no stale sections behind.
  useEffect(() => {
    const l = layouts.current;
    l.tops = l.tops.slice(0, count);
    l.heights = l.heights.slice(0, count);
    l.headers = l.headers.slice(0, count);
    tops.value = l.tops;
    heights.value = l.heights;
    headers.value = l.headers;
  }, [count, tops, heights, headers]);

  const measure = (kind: 'section' | 'header', index: number) => (event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    const l = layouts.current;
    if (kind === 'header') {
      l.headers = withAt(l.headers, index, height);
      headers.value = l.headers;
      return;
    }
    l.tops = withAt(l.tops, index, y);
    l.heights = withAt(l.heights, index, height);
    tops.value = l.tops;
    heights.value = l.heights;
  };

  return { count, stack, scrollY: scroll?.scrollY ?? fallback, tops, heights, headers, measure };
}

const withAt = (values: number[], index: number, value: number) => {
  const next = [...values];
  next[index] = value;
  return next;
};

/**
 * A section, drawn over the sections after it: its header rides up over the
 * top of the next one while that one pushes it out.
 */
export function StickySection({
  sticky,
  index,
  children,
}: Readonly<{ sticky: StickySections; index: number; children: ReactNode }>) {
  return (
    <View onLayout={sticky.measure('section', index)} style={{ zIndex: sticky.count - index }}>
      {children}
    </View>
  );
}

/**
 * A section's header. In place until its section reaches the top, then held
 * at the top while the section scrolls under it, until the next header is
 * `stack` below it (or, for the last one, its section ends) and it moves on
 * with the content.
 */
export function StickyHeader({
  sticky,
  index,
  style,
  children,
}: Readonly<{ sticky: StickySections; index: number; style?: StyleProp<ViewStyle>; children: ReactNode }>) {
  const { scrollY, tops, heights, headers, stack } = sticky;
  const ride = useAnimatedStyle(() => {
    const top = tops.value[index];
    if (top === undefined) return { transform: [{ translateY: 0 }] };
    const next = tops.value[index + 1];
    const room = next === undefined ? (heights.value[index] ?? 0) - (headers.value[index] ?? 0) : next - top - stack;
    return { transform: [{ translateY: Math.min(Math.max(scrollY.value - top, 0), Math.max(room, 0)) }] };
  });
  return (
    <Animated.View onLayout={sticky.measure('header', index)} style={[styles.header, style, ride]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Over its section's rows, which scroll under it.
  header: { zIndex: 1 },
});
