import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  FlatList,
  TouchableOpacity,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { ChevronLeft } from 'lucide-react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ImageItem {
  url: string;
  authorName?: string;
  createdAt?: string;
}

interface OriginRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImageViewerProps {
  images: ImageItem[];
  initialUrl: string | null;
  origin?: OriginRect | null;
  onClose: () => void;
}

const THUMB = 52;

function formatHeaderDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })}, ${time}`;
}

/** A single zoomable / pannable / swipe-to-dismiss page in the pager. */
function ZoomablePage({
  uri,
  width,
  height,
  dragY,
  exitProgress,
  origin,
  isOrigin,
  onDismiss,
  onZoomChange,
  onToggleChrome,
}: {
  uri: string;
  width: number;
  height: number;
  dragY: SharedValue<number>;
  exitProgress: SharedValue<number>;
  origin?: OriginRect | null;
  isOrigin: boolean;
  onDismiss: () => void;
  onZoomChange: (zoomed: boolean) => void;
  onToggleChrome: () => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const setZoomed = useCallback((z: boolean) => onZoomChange(z), [onZoomChange]);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, savedScale.value * e.scale);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(setZoomed)(false);
      } else {
        runOnJS(setZoomed)(true);
      }
    });

  const pan = Gesture.Pan()
    // Claim only vertical drags (swipe-to-dismiss): the pan activates once
    // vertical movement passes the threshold, so the horizontal pager keeps
    // handling left/right swipes. We deliberately DON'T failOffsetX — that made
    // even slightly-diagonal downward swipes fail to dismiss.
    .activeOffsetY([-10, 10])
    .onUpdate((e) => {
      if (scale.value > 1) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      } else {
        dragY.value = e.translationY;
      }
    })
    .onEnd((e) => {
      if (scale.value > 1) {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      } else if (Math.abs(e.translationY) > 90 || Math.abs(e.velocityY) > 700) {
        if (origin && isOrigin) {
          // Animate the photo back into its chat thumbnail (shared element).
          exitProgress.value = withTiming(
            0,
            { duration: 230, easing: Easing.in(Easing.cubic) },
            (finished) => {
              if (finished) runOnJS(onDismiss)();
            },
          );
        } else {
          // No known origin (e.g. swiped to another photo): slide off-screen.
          const dir = e.translationY >= 0 ? 1 : -1;
          dragY.value = withTiming(
            dir * height,
            { duration: 200, easing: Easing.in(Easing.cubic) },
            (finished) => {
              if (finished) runOnJS(onDismiss)();
            },
          );
        }
      } else {
        // Spring back to place.
        dragY.value = withTiming(0, { duration: 160 });
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(setZoomed)(false);
      } else {
        scale.value = withTiming(2.5);
        savedScale.value = 2.5;
        runOnJS(setZoomed)(true);
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(onToggleChrome)();
    });

  const composed = Gesture.Race(
    Gesture.Exclusive(doubleTap, singleTap),
    Gesture.Simultaneous(pinch, pan),
  );

  const imageStyle = useAnimatedStyle(() => {
    // Shrink slightly as it's dragged toward dismiss (WhatsApp-style).
    const dragScale = scale.value > 1
      ? 1
      : interpolate(Math.abs(dragY.value), [0, 400], [1, 0.7], Extrapolation.CLAMP);
    let tx = translateX.value;
    let ty = translateY.value + dragY.value;
    let sc = scale.value * dragScale;

    // Shared-element: when opening (exitProgress 0→1) or dismissing (1→0), the
    // origin image interpolates between its chat-thumbnail rect and fullscreen,
    // so it flies out of / back into its spot in the conversation. A short
    // opacity fade near the docked end hides the contain/cover crop mismatch.
    let opacity = 1;
    if (origin && isOrigin) {
      const ep = exitProgress.value;
      const targetScale = origin.width / width;
      const targetX = origin.x + origin.width / 2 - width / 2;
      const targetY = origin.y + origin.height / 2 - height / 2;
      tx = interpolate(ep, [0, 1], [targetX, tx], Extrapolation.CLAMP);
      ty = interpolate(ep, [0, 1], [targetY, ty], Extrapolation.CLAMP);
      sc = interpolate(ep, [0, 1], [targetScale, sc], Extrapolation.CLAMP);
      opacity = interpolate(ep, [0, 0.35, 1], [0, 1, 1], Extrapolation.CLAMP);
    } else if (isOrigin) {
      // Centered open: subtle scale-up + fade from the middle of the screen.
      const ep = exitProgress.value;
      sc = sc * interpolate(ep, [0, 1], [0.9, 1], Extrapolation.CLAMP);
      opacity = interpolate(ep, [0, 1], [0, 1], Extrapolation.CLAMP);
    }

    return {
      opacity,
      transform: [{ translateX: tx }, { translateY: ty }, { scale: sc }],
    };
  });

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={[{ width, height }, styles.pageCenter, imageStyle]}>
        <Image
          source={{ uri }}
          style={{ width, height }}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
      </Animated.View>
    </GestureDetector>
  );
}

export function ImageViewer({ images, initialUrl, origin, onClose }: ImageViewerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pagerRef = useRef<FlatList<ImageItem>>(null);
  const filmstripRef = useRef<FlatList<ImageItem>>(null);
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

  const initialIndex = Math.max(0, images.findIndex((im) => im.url === initialUrl));

  // Shared drag-to-dismiss offset — drives the image translate/scale AND the
  // backdrop fade so the chat behind shows through as you pull the photo down.
  const dragY = useSharedValue(0);
  // 0 = at the chat thumbnail (origin), 1 = fullscreen centered. Animates 0→1 on
  // open so the photo grows out of its thumbnail spot into the centered viewer,
  // and 1→0 on shared-element dismiss back into the conversation.
  const exitProgress = useSharedValue(origin ? 0 : 1);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity:
      exitProgress.value *
      interpolate(Math.abs(dragY.value), [0, 400], [1, 0], Extrapolation.CLAMP),
  }));

  // Animated chrome (header + filmstrip) — fades & slides instead of popping.
  const chromeSV = useSharedValue(1);
  useEffect(() => {
    chromeSV.value = withTiming(chromeVisible ? 1 : 0, { duration: 220 });
  }, [chromeVisible, chromeSV]);

  const headerAnimStyle = useAnimatedStyle(() => ({
    opacity:
      chromeSV.value *
      exitProgress.value *
      interpolate(Math.abs(dragY.value), [0, 120], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(chromeSV.value, [0, 1], [-24, 0], Extrapolation.CLAMP) }],
  }));
  const filmstripAnimStyle = useAnimatedStyle(() => ({
    opacity:
      chromeSV.value *
      exitProgress.value *
      interpolate(Math.abs(dragY.value), [0, 120], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(chromeSV.value, [0, 1], [40, 0], Extrapolation.CLAMP) }],
  }));

  const visible = initialUrl !== null && images.length > 0;

  // Sync to the tapped image when (re)opened.
  useEffect(() => {
    if (!visible) return;
    const i = Math.max(0, images.findIndex((im) => im.url === initialUrl));
    setIndex(i);
    setZoomed(false);
    setChromeVisible(true);
    dragY.value = 0;
    // Shared-element open: grow from the chat thumbnail into the centered viewer.
    exitProgress.value = origin ? 0 : 1;
    if (origin) {
      exitProgress.value = withTiming(1, { duration: 280, easing: Easing.out(Easing.cubic) });
    }
    // Jump the pager without animation on open.
    requestAnimationFrame(() => {
      pagerRef.current?.scrollToOffset({ offset: i * width, animated: false });
    });
  }, [visible, initialUrl, images, width, origin, exitProgress, dragY]);

  const onPagerScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / width);
      if (i !== index) {
        setIndex(i);
        filmstripRef.current?.scrollToIndex({ index: i, viewPosition: 0.5, animated: true });
      }
    },
    [index, width],
  );

  const jumpTo = useCallback(
    (i: number) => {
      setIndex(i);
      setZoomed(false);
      pagerRef.current?.scrollToOffset({ offset: i * width, animated: true });
      filmstripRef.current?.scrollToIndex({ index: i, viewPosition: 0.5, animated: true });
    },
    [width],
  );

  if (!visible) return null;

  const current = images[index];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* Backdrop fades out as the photo is dragged down, revealing the chat. */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]} />
      <View style={StyleSheet.absoluteFill}>
        {/* Pager */}
        <FlatList
          ref={pagerRef}
          data={images}
          keyExtractor={(it, i) => `${it.url}-${i}`}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialScrollIndex={Math.max(0, images.findIndex((im) => im.url === initialUrl))}
          onMomentumScrollEnd={onPagerScrollEnd}
          renderItem={({ item, index: i }) => (
            <ZoomablePage
              uri={item.url}
              width={width}
              height={height}
              dragY={dragY}
              exitProgress={exitProgress}
              origin={origin}
              isOrigin={i === initialIndex}
              onDismiss={onClose}
              onZoomChange={setZoomed}
              onToggleChrome={() => setChromeVisible((v) => !v)}
            />
          )}
        />

        {/* Header */}
        <Animated.View
          style={[styles.header, { paddingTop: insets.top + 6 }, headerAnimStyle]}
          pointerEvents={chromeVisible ? 'box-none' : 'none'}
        >
          <Pressable
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.backBtn}
          >
            <ChevronLeft size={26} color="#fff" strokeWidth={2.4} />
          </Pressable>
          <View style={styles.headerText} pointerEvents="none">
            <Text style={styles.headerName} numberOfLines={1}>
              {current?.authorName || ''}
            </Text>
            <Text style={styles.headerDate} numberOfLines={1}>
              {formatHeaderDate(current?.createdAt)}
            </Text>
          </View>
        </Animated.View>

        {/* Bottom filmstrip */}
        {images.length > 1 && (
          <Animated.View
            style={[styles.filmstripWrap, { paddingBottom: insets.bottom + 10 }, filmstripAnimStyle]}
            pointerEvents={chromeVisible ? 'box-none' : 'none'}
          >
            <FlatList
              ref={filmstripRef}
              data={images}
              keyExtractor={(it, i) => `thumb-${it.url}-${i}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filmstripContent}
              getItemLayout={(_, i) => ({ length: THUMB + 6, offset: (THUMB + 6) * i, index: i })}
              initialScrollIndex={Math.max(0, images.findIndex((im) => im.url === initialUrl))}
              renderItem={({ item, index: i }) => (
                <TouchableOpacity activeOpacity={0.8} onPress={() => jumpTo(i)}>
                  <Image
                    source={{ uri: item.url }}
                    style={[styles.thumb, i === index && styles.thumbActive]}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                  />
                </TouchableOpacity>
              )}
            />
          </Animated.View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: '#000',
  },
  pageCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 10,
    gap: 6,
    backgroundColor: '#000',
  },
  backBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerText: { flex: 1, justifyContent: 'center' },
  headerName: { fontSize: 16, fontWeight: '600', color: '#fff' },
  headerDate: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 1 },
  filmstripWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    paddingTop: 10,
  },
  filmstripContent: {
    paddingHorizontal: 12,
    gap: 6,
    alignItems: 'center',
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    opacity: 0.55,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbActive: {
    opacity: 1,
    borderColor: '#fff',
  },
});
