/**
 * Sticky section headers, the way iOS lists do them. While a list scrolls,
 * the header of the section at the top stays pinned above it; the next
 * section's header slides up underneath, pushes the pinned one out, and takes
 * its place.
 *
 * `Screen` owns the scroll view and provides the scroll position and the
 * pinned slot; a list registers its sections with `useStickySections`, which
 * says which one is at the top, and hands its header to `Pinned`.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LayoutChangeEvent, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

interface StickyScroll {
  /** The scroll view's content offset. */
  scrollY: SharedValue<number>;
  /** What sits pinned at the top of the scroll view; null for nothing. */
  setPinned: (node: ReactNode) => void;
}

export const StickyScrollContext = createContext<StickyScroll | null>(null);

/** Where section tops are, which one is at the top for `scrollY`. Runs on the UI thread too. */
function activeSection(offsets: number[], scrollY: number): number {
  'worklet';
  let index = -1;
  for (let i = 0; i < offsets.length; i++) {
    const top = offsets[i];
    if (top !== undefined && top <= scrollY + 1) index = i;
  }
  return index;
}

export interface StickySections {
  /** The section whose header is pinned, or -1 while the first one is still in place. */
  active: number;
  /** For the onLayout of section `index`'s outer view, a direct child of the screen's content. */
  onSectionLayout: (index: number) => (event: LayoutChangeEvent) => void;
  /** Moves the pinned header up as the next section's header pushes it out. */
  slide: { style: AnimatedStyle<ViewStyle>; onLayout: (event: LayoutChangeEvent) => void };
}

/**
 * Which of `count` sections is at the top of the screen's scroll view.
 * `textTop` is how far below a section's top its header text starts: the
 * next header pushes the pinned one only once its text reaches the pinned
 * text, so the two lines stack close together and slide away as one.
 */
export function useStickySections(count: number, textTop: number): StickySections {
  const scroll = useContext(StickyScrollContext);
  const fallback = useSharedValue(0);
  const scrollY = scroll?.scrollY ?? fallback;
  const offsets = useSharedValue<number[]>([]);
  const height = useSharedValue(0);
  const [active, setActive] = useState(-1);
  const layouts = useRef<number[]>([]);

  useEffect(() => {
    layouts.current = layouts.current.slice(0, count);
    offsets.value = layouts.current;
  }, [count, offsets]);

  useAnimatedReaction(
    () => activeSection(offsets.value, scrollY.value),
    (index, previous) => {
      if (index !== previous) scheduleOnRN(setActive, index);
    },
  );

  // Pinned at 0 until the next header's text reaches the bottom of the pinned
  // header (its text plus a small gap), then it rides up with it.
  const style = useAnimatedStyle(() => {
    const index = activeSection(offsets.value, scrollY.value);
    const next = offsets.value[index + 1];
    const push =
      index >= 0 && next !== undefined && height.value > 0 ? next - scrollY.value - (height.value - textTop) : 0;
    return { transform: [{ translateY: Math.min(0, push) }] };
  });

  const onSectionLayout = (index: number) => (event: LayoutChangeEvent) => {
    const next = [...layouts.current];
    next[index] = event.nativeEvent.layout.y;
    layouts.current = next;
    offsets.value = next;
  };

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      height.value = event.nativeEvent.layout.height;
    },
    [height],
  );
  const slide = useMemo(() => ({ style, onLayout }), [style, onLayout]);

  return { active, onSectionLayout, slide };
}

/** Puts `children` in the pinned slot at the top of the screen's scroll view while mounted. */
export function Pinned({ slide, children }: Readonly<{ slide: StickySections['slide']; children: ReactNode }>) {
  const scroll = useContext(StickyScrollContext);
  const setPinned = scroll?.setPinned;
  useEffect(() => {
    setPinned?.(
      children ? (
        <Animated.View style={slide.style} onLayout={slide.onLayout}>
          {children}
        </Animated.View>
      ) : null,
    );
  }, [setPinned, children, slide.style, slide.onLayout]);
  useEffect(() => () => setPinned?.(null), [setPinned]);
  return null;
}
