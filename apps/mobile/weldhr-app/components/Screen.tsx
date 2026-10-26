/**
 * Screen chrome: on a tinted header, the title on the left (after the back
 * or close button, when there is one) and square buttons on the right, then optionally a segmented control and a period navigator ("Week
 * 43", "Sunday 25 October"), and under that a white sheet with small rounded
 * corners and a grabber that holds the list. Pulling the sheet down reveals what sits behind it (a month
 * calendar to jump to another week or day).
 *
 * Home and the detail pages (a shift, leave, a sick report) have no sheet:
 * their cards sit straight on a white page. Home has the workspace on the
 * left in place of the title. A `plain` page (Expenses, the detail pages) is
 * white all over: no sheet, and grey buttons and segments instead of blue. Pushed screens get a back
 * button, forms a close button, both square like the rest.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FLOATING_TAB_BAR_HEIGHT, floatingTabBarBottomInset } from '@weldsuite/mobile-ui/components/FloatingTabBar';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { AlertCircle, ChevronLeft, ChevronRight, X, type LucideIcon } from 'lucide-react-native';

import { usePalette } from '@/hooks/use-palette';
import { useI18n } from '@/lib/i18n';
import { StickyScrollContext } from './Sticky';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  testID?: string;
}

/** Whether the screen is `plain`, for the grey buttons and segments in its header. */
const PlainContext = createContext(false);

interface ScreenProps {
  title: string;
  /** `push` shows a back button on the left, `modal` a close button (forms). */
  variant?: 'tab' | 'push' | 'modal';
  /** Square button left of the title (tab screens only). */
  left?: ReactNode;
  /** Square button right of the title. */
  right?: ReactNode;
  /** On the left in place of the centred title and left button (Home's workspace menu). */
  heading?: ReactNode;
  /** Above the period: the screen's views ("My schedule", "Team"). */
  segments?: ReactNode;
  /** A `PeriodNav` under the segments. */
  period?: ReactNode;
  /** What pulling the sheet down reveals; `close` slides the sheet back up. */
  behind?: (close: () => void) => ReactNode;
  /** False puts the content straight on a plain white page, no tinted header (Home, detail pages). */
  sheet?: boolean;
  /** No sheet and no blue: grey square buttons and segments on white (Expenses, detail pages). */
  plain?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}

export function Screen({
  title,
  variant = 'tab',
  left,
  right,
  heading,
  segments,
  period,
  behind,
  sheet: withSheet = true,
  plain = false,
  refreshing = false,
  onRefresh,
  children,
  contentStyle,
}: Readonly<ScreenProps>) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const sheet = withSheet && !plain;
  const isModal = variant === 'modal';
  // A modal is a page sheet on iOS: it starts below the status bar already.
  const top = isModal ? 14 : insets.top + 6;
  // On tab screens the content runs on under the floating tab bar and the
  // round "+" above it (AddButton), which float over it; the end of the list
  // is padded so its last row can scroll clear of both. Pushed screens and
  // forms run to the home indicator.
  const bottom =
    variant === 'tab'
      ? floatingTabBarBottomInset(insets.bottom) + FLOATING_SIZE + FLOATING_GAP + 16
      : insets.bottom + 24;
  const leftButton = variant === 'tab' ? left : <BackButton modal={isModal} />;

  const scroll = (
    <ScreenScroll
      contentStyle={[{ paddingBottom: bottom }, plain && styles.plainContent, isModal && styles.form, contentStyle]}
      refreshing={refreshing}
      onRefresh={onRefresh}
    >
      {children}
    </ScreenScroll>
  );

  return (
    <PlainContext.Provider value={plain}>
      <View style={[styles.flex, { backgroundColor: sheet ? palette.canvas : palette.surface }]}>
        <View style={{ paddingTop: top }}>
          <View style={styles.titleRow}>
            {heading ? (
              <View style={styles.heading}>{heading}</View>
            ) : (
              <>
                {leftButton ? <View style={styles.leading}>{leftButton}</View> : null}
                <Text
                  style={[styles.title, { color: palette.text }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.75}
                  accessibilityRole="header"
                >
                  {title}
                </Text>
              </>
            )}
            <View style={[styles.slot, styles.slotRight]}>{right}</View>
          </View>
          {segments}
          {period}
        </View>
        {sheet ? <PullSheet behind={behind}>{scroll}</PullSheet> : scroll}
      </View>
    </PlainContext.Provider>
  );
}


/** The back arrow on a pushed screen, the close cross on a form; to the tabs when there is nothing to go back to. */
function BackButton({ modal }: Readonly<{ modal: boolean }>) {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <SquareButton
      icon={modal ? X : ChevronLeft}
      label={modal ? t.common.close : t.common.back}
      testID={modal ? 'screen-close' : 'screen-back'}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
    />
  );
}

/**
 * The scrolling content: pull to refresh, and the slot sticky section headers
 * pin into (Sticky.tsx).
 */
function ScreenScroll({
  contentStyle,
  refreshing,
  onRefresh,
  children,
}: Readonly<{
  contentStyle: StyleProp<ViewStyle>;
  refreshing: boolean;
  onRefresh?: () => void;
  children: ReactNode;
}>) {
  const palette = usePalette();

  // Show the spinner only for a pull, not for every background refetch, and
  // long enough to register even when the data comes back at once.
  const [pulled, setPulled] = useState(false);
  useEffect(() => {
    if (!pulled || refreshing) return undefined;
    const id = setTimeout(() => setPulled(false), 400);
    return () => clearTimeout(id);
  }, [pulled, refreshing]);

  // The scroll offset and the pinned slot for sticky section headers.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const [pinned, setPinned] = useState<ReactNode>(null);
  const sticky = useMemo(() => ({ scrollY, setPinned }), [scrollY]);

  return (
    <View style={[styles.flex, styles.clip]}>
      <Animated.ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, contentStyle]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={pulled}
              onRefresh={() => {
                setPulled(true);
                onRefresh();
              }}
              tintColor={palette.muted}
            />
          ) : undefined
        }
      >
        <StickyScrollContext.Provider value={sticky}>{children}</StickyScrollContext.Provider>
      </Animated.ScrollView>
      {pinned ? (
        <View style={styles.pinned} pointerEvents="box-none">
          {pinned}
        </View>
      ) : null}
    </View>
  );
}

const SPRING = { damping: 22, stiffness: 220, mass: 0.8 };

/**
 * The white sheet. With something behind it, dragging the grabber down
 * slides the sheet off it; a fling or dragging past half-way settles open.
 */
function PullSheet({
  behind,
  children,
}: Readonly<{
  behind?: (close: () => void) => ReactNode;
  children: ReactNode;
}>) {
  const palette = usePalette();
  const [depth, setDepth] = useState(0);
  const [open, setOpen] = useState(false);
  const offset = useSharedValue(0);
  const start = useSharedValue(0);

  const settle = (toOpen: boolean) => {
    offset.value = withSpring(toOpen ? depth : 0, SPRING);
    setOpen(toOpen);
  };

  const pan = Gesture.Pan()
    .enabled(Boolean(behind) && depth > 0)
    .onBegin(() => {
      start.value = offset.value;
    })
    .onUpdate((event) => {
      offset.value = Math.min(depth, Math.max(0, start.value + event.translationY));
    })
    .onEnd((event) => {
      const toOpen = event.velocityY > 400 || (event.velocityY > -400 && offset.value > depth / 2);
      offset.value = withSpring(toOpen ? depth : 0, SPRING);
      scheduleOnRN(setOpen, toOpen);
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  const onBehindLayout = (event: LayoutChangeEvent) => setDepth(Math.round(event.nativeEvent.layout.height));

  return (
    <View style={styles.flex}>
      {behind ? (
        <View style={styles.behind} onLayout={onBehindLayout} pointerEvents={open ? 'auto' : 'none'}>
          {behind(() => settle(false))}
        </View>
      ) : null}
      <Animated.View style={[styles.sheet, { backgroundColor: palette.surface }, sheetStyle]}>
        <GestureDetector gesture={pan}>
          <Pressable
            onPress={behind ? () => settle(!open) : undefined}
            accessibilityRole={behind ? 'button' : undefined}
            style={styles.grabberZone}
            testID="sheet-grabber"
          >
            <View style={[styles.grabber, { backgroundColor: palette.grabber }]} />
          </Pressable>
        </GestureDetector>
        {children}
      </Animated.View>
    </View>
  );
}

/** The square header button: a back arrow, "+", a filter. */
export function SquareButton({
  icon: Icon,
  label,
  onPress,
  testID,
  disabled = false,
}: Readonly<{
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
}>) {
  const palette = usePalette();
  const plain = useContext(PlainContext);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      hitSlop={6}
      style={({ pressed }) => [
        styles.square,
        {
          backgroundColor: plain ? palette.chromePlain : palette.chrome,
          opacity: pressedOpacity(pressed, disabled),
        },
      ]}
    >
      <Icon size={20} color={palette.text} strokeWidth={2} />
    </Pressable>
  );
}

/** A square button's opacity: faded while disabled, dimmed while pressed. */
function pressedOpacity(pressed: boolean, disabled: boolean): number {
  if (disabled) return 0.45;
  return pressed ? 0.7 : 1;
}

/** How far above the bottom edge the round button floats: the tab bar sits max(inset, 8) up (FloatingTabBar). */
export function floatingButtonBottom(safeAreaBottom: number): number {
  return Math.max(safeAreaBottom, 8) + FLOATING_TAB_BAR_HEIGHT + FLOATING_GAP;
}

/** The round button floating above the tab bar: white like the bar, with its hairline and shadow. */
export function FloatingButton({
  icon: Icon,
  label,
  onPress,
  testID,
}: Readonly<{ icon: LucideIcon; label: string; onPress: () => void; testID?: string }>) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [
        styles.floatingButton,
        { backgroundColor: palette.surface, borderColor: palette.border, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Icon size={26} color={palette.text} strokeWidth={2.2} />
    </Pressable>
  );
}

/** The segmented control under the title: a grey track with a white thumb, as on iOS. */
export function Segments<T extends string>({
  value,
  options,
  onChange,
  style,
}: Readonly<{
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}>) {
  const palette = usePalette();
  const plain = useContext(PlainContext);
  if (options.length < 2) return null;
  return (
    <View
      style={[styles.segments, { backgroundColor: plain ? palette.chromePlain : palette.chrome }, style]}
      accessibilityRole="tablist"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            testID={option.testID}
            style={[
              styles.segment,
              selected && [styles.segmentSelected, { backgroundColor: plain ? palette.thumbPlain : palette.thumb }],
            ]}
          >
            <Text
              style={[
                styles.segmentLabel,
                { color: selected ? palette.text : palette.muted },
                selected && styles.segmentLabelSelected,
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "Week 43 / 19 Oct – 25 Oct" between square arrows; an arrow without a handler is left out. */
export function PeriodNav({
  label,
  sublabel,
  onPrevious,
  onNext,
}: Readonly<{
  label: string;
  sublabel?: string;
  onPrevious?: () => void;
  onNext?: () => void;
}>) {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <View style={styles.period}>
      <View style={styles.slot}>
        {onPrevious ? (
          <SquareButton icon={ChevronLeft} label={t.calendar.previous} onPress={onPrevious} testID="period-previous" />
        ) : null}
      </View>
      <View style={styles.periodLabels}>
        <Text style={[styles.periodLabel, { color: palette.text }]} numberOfLines={1}>
          {label}
        </Text>
        {sublabel ? (
          <Text style={[styles.periodSub, { color: palette.muted }]} numberOfLines={1}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      <View style={[styles.slot, styles.slotRight]}>
        {onNext ? (
          <SquareButton icon={ChevronRight} label={t.calendar.next} onPress={onNext} testID="period-next" />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A titled block. In a sheet the title is 18pt with an optional figure on the
 * right ("0:00", "1 Jan – 31 Dec"); `large` is Home's 22pt heading.
 */
export function Section({
  title,
  meta,
  large = false,
  first = false,
  children,
  style,
}: Readonly<{
  title?: string;
  meta?: string | null;
  large?: boolean;
  first?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}>) {
  const palette = usePalette();
  return (
    <View style={[large ? styles.sectionLarge : styles.section, first && styles.sectionFirst, style]}>
      {title ? (
        <View style={styles.sectionHeader}>
          <Text
            style={[large ? styles.sectionTitleLarge : styles.sectionTitle, { color: palette.text }]}
            numberOfLines={1}
            accessibilityRole="header"
          >
            {title}
          </Text>
          {meta ? <Text style={[styles.sectionMeta, { color: palette.muted }]}>{meta}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** The side margin, for blocks that should not run edge to edge. */
export function Inset({ children, style }: Readonly<{ children: ReactNode; style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.inset, style]}>{children}</View>;
}

/** Short inline error, e.g. under a form. */
export function ErrorNote({ message }: Readonly<{ message: string }>) {
  const palette = usePalette();
  return <Text style={[styles.error, { color: palette.danger }]}>{message}</Text>;
}

/** A failed load: what went wrong and a retry, instead of an empty screen. */
export function ErrorState({ onRetry }: Readonly<{ onRetry?: () => void }>) {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <View style={styles.errorState}>
      <AlertCircle size={30} color={palette.muted} />
      <Text style={[styles.errorText, { color: palette.muted }]}>{t.common.somethingWrong}</Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.retry, { backgroundColor: palette.control, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.retryText, { color: palette.text }]}>{t.common.retry}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const SQUARE = 40;
const FLOATING_SIZE = 56;
/** Between the floating button and the tab bar under it. */
const FLOATING_GAP = 16;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Fills the visible height, so an empty state can centre in it.
  content: { flexGrow: 1 },
  // A little air between a plain page's header and its first card, where a sheet has its grabber.
  plainContent: { paddingTop: 4 },
  // The pinned header slides out under the top edge of the list, not over the grabber.
  clip: { overflow: 'hidden' },
  pinned: { position: 'absolute', top: 0, left: 0, right: 0 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 44,
  },
  slot: { width: SQUARE + 8, flexDirection: 'row' },
  slotRight: { justifyContent: 'flex-end' },
  title: { flex: 1, textAlign: 'left', fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
  leading: { marginRight: 12 },
  heading: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  square: {
    width: SQUARE,
    height: SQUARE,
    borderRadius: 12,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  segments: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    padding: 3,
    height: 38,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingHorizontal: 4,
  },
  segmentSelected: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentLabel: { fontSize: 14, fontWeight: '500' },
  segmentLabelSelected: { fontWeight: '600' },
  period: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginTop: 12,
    minHeight: SQUARE,
  },
  periodLabels: { flex: 1, alignItems: 'center' },
  periodLabel: { fontSize: 17, fontWeight: '600' },
  periodSub: { fontSize: 14, marginTop: 1 },
  behind: { position: 'absolute', top: 0, left: 0, right: 0 },
  floatingButton: {
    width: FLOATING_SIZE,
    height: FLOATING_SIZE,
    borderRadius: FLOATING_SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 12,
  },
  sheet: {
    flex: 1,
    marginTop: 12,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  grabberZone: { alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  grabber: { width: 38, height: 4, borderRadius: 2 },
  form: { paddingHorizontal: 16, paddingTop: 12, gap: 16 },
  section: { marginTop: 22 },
  sectionLarge: { marginTop: 28 },
  sectionFirst: { marginTop: 8 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  sectionTitle: { flexShrink: 1, fontSize: 17, fontWeight: '700' },
  sectionTitleLarge: {
    flexShrink: 1,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  sectionMeta: { fontSize: 14, fontVariant: ['tabular-nums'] },
  inset: { paddingHorizontal: 16 },
  error: { fontSize: 13 },
  errorState: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
    gap: 12,
  },
  errorText: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  retry: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { fontSize: 15, fontWeight: '600' },
});
