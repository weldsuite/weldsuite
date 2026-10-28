/**
 * Screen chrome on a white page: the title on the left (after the back or
 * close button, when there is one) and grey square buttons on the right,
 * then optionally the screen's views as text tabs and a period navigator
 * ("Week 43", "Sunday 25 October"), and under that the content.
 *
 * A screen with something behind its list (the month calendar on Schedule
 * and Absence) has a light grey top and holds the list in a white sheet with
 * a grabber: pulling it down reveals the calendar to jump to another week or
 * day. Home has the workspace on the left in place of the title. Pushed
 * screens get a bare back chevron and a smaller title, forms a square close
 * button like the rest.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
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
  Easing,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import * as Haptics from 'expo-haptics';
import { AlertCircle, ChevronLeft, ChevronRight, X, type LucideIcon } from 'lucide-react-native';

import { usePalette } from '@/hooks/use-palette';
import { useI18n } from '@/lib/i18n';
import { StickyScrollContext } from './Sticky';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  testID?: string;
}

/** Whether the header sits on the grey canvas, for square buttons a step darker. */
const CanvasContext = createContext(false);

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
  /** False puts the content straight under the header with no air above it (Home). */
  sheet?: boolean;
  /** Never a sheet, even with something behind (detail pages). */
  plain?: boolean;
  /**
   * The grey top and the sheet even on a view with nothing behind it, so the
   * header keeps its colour between tabs (Absence, where only one tab has a calendar).
   */
  keepSheet?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  /** The page's colour where it is not white (the profile's grouped cards sit on a light grey). */
  background?: string;
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
  keepSheet = false,
  refreshing = false,
  onRefresh,
  children,
  contentStyle,
  background,
}: Readonly<ScreenProps>) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  // Only a list with something to pull down to sits in a sheet.
  const sheet = withSheet && !plain && (Boolean(behind) || keepSheet);
  // A sheet with nothing above it but the tabs (Absence → Requests) starts at
  // their line, square and without a grabber, as a plain page does.
  const flush = sheet && !period && !behind;
  const isModal = variant === 'modal';
  const { top, bottom } = screenEdges(variant, insets);
  const leftButton = variant === 'tab' ? left : <BackButton modal={isModal} />;
  const pushed = variant === 'push';
  // A line under a pushed screen's header, as a nav bar; tabs under the title draw their own.
  const ruled = pushed && !segments && !period;

  const scroll = (
    <ScreenScroll
      contentStyle={[
        { paddingBottom: bottom },
        ((withSheet && !sheet) || flush) && styles.plainContent,
        ruled && styles.ruledContent,
        isModal && styles.form,
        contentStyle,
      ]}
      refreshing={refreshing}
      onRefresh={onRefresh}
    >
      {children}
    </ScreenScroll>
  );

  return (
    <CanvasContext.Provider value={sheet}>
      <View style={[styles.flex, { backgroundColor: background ?? (sheet ? palette.canvas : palette.surface) }]}>
        <View style={[{ paddingTop: top }, ruled && [styles.ruled, { borderBottomColor: palette.border }]]}>
          <ScreenTitle title={title} heading={heading} leftButton={leftButton} pushed={pushed} right={right} />
          {segments}
          {period}
        </View>
        {sheet ? (
          <PullSheet behind={behind} flush={flush}>
            {scroll}
          </PullSheet>
        ) : (
          scroll
        )}
      </View>
    </CanvasContext.Provider>
  );
}

/**
 * Where a screen's header starts and its content ends. A modal is a page sheet
 * on iOS: it starts below the status bar already. On tab screens the content
 * runs on under the floating tab bar and the round "+" above it (AddButton),
 * which float over it; the end of the list is padded so its last row can
 * scroll clear of both. Pushed screens and forms run to the home indicator.
 */
function screenEdges(variant: ScreenProps['variant'], insets: { top: number; bottom: number }) {
  return {
    top: variant === 'modal' ? 14 : insets.top + 16,
    bottom:
      variant === 'tab'
        ? floatingTabBarBottomInset(insets.bottom) + FLOATING_SIZE + FLOATING_GAP + 16
        : insets.bottom + 24,
  };
}

/** The header's line: a heading of its own (Home's workspace), or the back button and the title; the right slot. */
function ScreenTitle({
  title,
  heading,
  leftButton,
  pushed,
  right,
}: Readonly<{ title: string; heading?: ReactNode; leftButton?: ReactNode; pushed: boolean; right?: ReactNode }>) {
  const palette = usePalette();
  return (
    <View style={styles.titleRow}>
      {heading ? (
        <View style={styles.heading}>{heading}</View>
      ) : (
        <>
          {leftButton ? <View style={pushed ? styles.leadingBack : styles.leading}>{leftButton}</View> : null}
          <Text
            style={[styles.title, pushed && styles.titlePushed, { color: palette.text }]}
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
  );
}

/**
 * The back chevron on a pushed screen, bare as on iOS, the square close cross
 * on a form; to the tabs when there is nothing to go back to.
 */
function BackButton({ modal }: Readonly<{ modal: boolean }>) {
  const palette = usePalette();
  const router = useRouter();
  const { t } = useI18n();
  const onPress = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));
  if (modal) return <SquareButton icon={X} label={t.common.close} testID="screen-close" onPress={onPress} />;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t.common.back}
      testID="screen-back"
      hitSlop={10}
      style={({ pressed }) => [styles.back, { opacity: pressed ? 0.5 : 1 }]}
    >
      <ChevronLeft size={BACK_ICON} color={palette.text} strokeWidth={2.2} />
    </Pressable>
  );
}

/**
 * The scrolling content: pull to refresh, and the scroll position sticky
 * section headers ride on (Sticky.tsx).
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

  // The scroll offset, for sticky section headers.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const sticky = useMemo(() => ({ scrollY }), [scrollY]);

  return (
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
  );
}

const SPRING = { damping: 22, stiffness: 220, mass: 0.8 };

/**
 * The white sheet. With something behind it, dragging the grabber down
 * slides the sheet off it; a fling or dragging past half-way settles open.
 * `flush` joins it to the tab line above it: no gap, no rounded top, no grabber.
 */
function PullSheet({
  behind,
  flush = false,
  children,
}: Readonly<{
  behind?: (close: () => void) => ReactNode;
  flush?: boolean;
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
      <Animated.View style={[styles.sheet, flush && styles.sheetFlush, { backgroundColor: palette.surface }, sheetStyle]}>
        {flush ? null : (
          <GestureDetector gesture={pan}>
            <Pressable
              onPress={behind ? () => settle(!open) : undefined}
              accessibilityRole={behind ? 'button' : undefined}
              style={styles.grabberZone}
              testID="sheet-grabber"
            >
              {behind ? <View style={[styles.grabber, { backgroundColor: palette.grabber }]} /> : null}
            </Pressable>
          </GestureDetector>
        )}
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
  const onCanvas = useContext(CanvasContext);
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
          backgroundColor: onCanvas ? palette.canvasControl : palette.chrome,
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

/** A segmented control for a setting (language, appearance): a grey track with a white thumb, as on iOS. */
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
  if (options.length < 2) return null;
  return (
    <View style={[styles.segments, { backgroundColor: palette.chrome }, style]} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            testID={option.testID}
            style={[styles.segment, selected && [styles.segmentSelected, { backgroundColor: palette.thumb }]]}
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

/** Where a tab sits in its strip, for the line under the chosen one. */
type TabLayout = { x: number; width: number };

/** The line under the chosen tab glides over to the next one. */
const TAB_SLIDE = { duration: 260, easing: Easing.out(Easing.cubic) };

/**
 * The screen's views as text tabs under the title, as in Employes: the chosen
 * one in black with a line under it that slides across when another is
 * picked, and a hairline across the page underneath.
 */
export function TabStrip<T extends string>({
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
  const onCanvas = useContext(CanvasContext);
  const [layouts, setLayouts] = useState<Record<string, TabLayout>>({});
  const lineX = useSharedValue(0);
  const lineWidth = useSharedValue(0);
  const placed = useRef(false);

  useEffect(() => {
    const target = layouts[value];
    if (!target) return;
    // The first time the line is simply there; after that it slides.
    if (placed.current) {
      lineX.value = withTiming(target.x, TAB_SLIDE);
      lineWidth.value = withTiming(target.width, TAB_SLIDE);
    } else {
      lineX.value = target.x;
      lineWidth.value = target.width;
      placed.current = true;
    }
  }, [value, layouts, lineX, lineWidth]);

  const lineStyle = useAnimatedStyle(() => ({
    width: lineWidth.value,
    transform: [{ translateX: lineX.value }],
  }));

  if (options.length < 2) return null;
  // Scrolls sideways when the labels are wider than a small phone (three tabs on Absence).
  return (
    <View style={[styles.tabStrip, { borderBottomColor: onCanvas ? palette.canvasBorder : palette.border }, style]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        alwaysBounceHorizontal={false}
        contentContainerStyle={styles.tabRow}
        accessibilityRole="tablist"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => {
                if (selected) return;
                void Haptics.selectionAsync();
                onChange(option.value);
              }}
              onLayout={(e: LayoutChangeEvent) => {
                const { x, width } = e.nativeEvent.layout;
                setLayouts((prev) => ({ ...prev, [option.value]: { x, width } }));
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              testID={option.testID}
              style={styles.tab}
            >
              <Text style={[styles.tabLabel, { color: selected ? palette.text : palette.muted }]} numberOfLines={1}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
        <Animated.View style={[styles.tabLine, { backgroundColor: palette.text }, lineStyle]} />
      </ScrollView>
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
/** The bare back chevron; lucide draws it in the middle quarter of its box. */
const BACK_ICON = 26;
const FLOATING_SIZE = 56;
/** Between the floating button and the tab bar under it. */
const FLOATING_GAP = 16;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Fills the visible height, so an empty state can centre in it.
  content: { flexGrow: 1 },
  // A little air between the header and the first card, where a sheet has its grabber.
  plainContent: { paddingTop: 4 },
  // The line runs edge to edge just under the title.
  ruled: { paddingBottom: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  ruledContent: { paddingTop: 10 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 44,
  },
  slot: { width: SQUARE + 8, flexDirection: 'row' },
  slotRight: { justifyContent: 'flex-end' },
  title: { flex: 1, textAlign: 'left', fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
  titlePushed: { fontSize: 24, letterSpacing: -0.4 },
  leading: { marginRight: 12 },
  // The chevron's stroke on the page's 16pt edge, the title 16pt after it.
  leadingBack: { marginLeft: -Math.round((BACK_ICON * 9) / 24), marginRight: 6 },
  back: { height: SQUARE, justifyContent: 'center' },
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
  // Left-aligned with the title; the hairline runs from edge to edge.
  tabStrip: { marginTop: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  tabRow: { flexDirection: 'row', gap: 24, paddingHorizontal: 16 },
  tab: { paddingTop: 10, paddingBottom: 12 },
  // One weight for chosen and not, so a label does not change width when picked.
  tabLabel: { fontSize: 16, fontWeight: '600' },
  // On top of the hairline, not above it.
  tabLine: { position: 'absolute', left: 0, bottom: -StyleSheet.hairlineWidth, height: 2, borderRadius: 1 },
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
  sheet: {
    flex: 1,
    marginTop: 12,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  sheetFlush: { marginTop: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  // A 40pt strip to grab, on top of the list: the list starts 10pt below the
  // sheet's edge, under it, so the first line sits close to the grabber.
  grabberZone: { alignItems: 'center', paddingTop: 10, paddingBottom: 26, marginBottom: -30, zIndex: 1 },
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
