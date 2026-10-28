/**
 * The round "+" above the tab bar and the card it opens: WeldChat's compose
 * menu (weldchat-app/components/home/ComposeMenu.tsx), kept the same so the
 * two apps feel alike, except that the round button is black here, like the
 * app's primary buttons. A few things to start, each an icon with a title and
 * a hint, and the main action as a wide button underneath.
 *
 * The button morphs into the card and back: one shape whose size, position,
 * corners and shadow go from exactly the round button to the card. While the
 * card is up the real button is hidden, and at both ends of the animation the
 * shape looks exactly like it, so the hand-over is invisible.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Modal, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Plus } from 'lucide-react-native';
import { Colors } from '@weldsuite/mobile-ui/constants/theme';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

type ThemeColors = (typeof Colors)['light'];

export interface ComposeMenuItem {
  key: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
  onPress: () => void;
  testID?: string;
}

interface ComposeMenuProps {
  open: boolean;
  onOpen: () => void;
  /** Distance from the bottom of the screen to the button's (and card's) bottom edge. */
  bottom: number;
  /** The same edge, measured inside the button's parent. */
  buttonBottom: number;
  buttonLabel: string;
  buttonTestID?: string;
  items: ComposeMenuItem[];
  primary: { icon: React.ReactNode; label: string; onPress: () => void; testID?: string };
  /** Tap outside the card or the Android back button. */
  onRequestClose: () => void;
  /** The card's Modal is gone: safe to present another screen now. */
  onClosed: () => void;
}

const BUTTON_SIZE = 56;
/** Lined up with the tab bar's right edge (WeldChat's sits at 16). */
const BUTTON_RIGHT = 20;
const ICON_SIZE = 22;
const CARD_RADIUS = 28;
/** The actions inside the card, 12pt in from its edge. */
const BUTTON_RADIUS = 18;
/** The floating tab bar's box: 20pt in from each side, at most 420pt wide. */
const CARD_INSET = 20;
const CARD_MAX_WIDTH = 420;
/** A first guess at the card's height, replaced by the measured one. */
const CARD_HEIGHT_GUESS = 196;
/**
 * Opening: a spring timed by duration, so it eases out of the button instead
 * of jumping halfway in the first frame, and settles with a hint of overshoot.
 */
const OPEN_SPRING = { duration: 460, dampingRatio: 0.84 };
/** Closing: quick to start, then lands softly on the round button. */
const CLOSE_TIMING = { duration: 230, easing: Easing.bezier(0.3, 0, 0.1, 1) };

export function ComposeMenu({
  open,
  onOpen,
  bottom,
  buttonBottom,
  buttonLabel,
  buttonTestID,
  items,
  primary,
  onRequestClose,
  onClosed,
}: Readonly<ComposeMenuProps>) {
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const styles = makeStyles(colors, isDark);
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth = Math.min(screenWidth - CARD_INSET * 2, CARD_MAX_WIDTH);
  const cardRight = (screenWidth - cardWidth) / 2;
  const [mounted, setMounted] = useState(false);
  // The Modal is on screen and its shape covers the button: only then is the
  // real button hidden, or it would blink out for the frame in between.
  const [covered, setCovered] = useState(false);
  const progress = useSharedValue(0);
  const cardHeight = useSharedValue(CARD_HEIGHT_GUESS);
  const openRef = useRef(open);
  const shownRef = useRef(false);

  const grow = () => {
    progress.value = withSpring(1, OPEN_SPRING);
  };

  useEffect(() => {
    openRef.current = open;
    if (open) {
      // The Modal takes a frame or two to appear; growing before then would
      // skip the start of the morph. If it is already up (re-opened while
      // closing), grow from where it is.
      if (shownRef.current) grow();
      else setMounted(true);
    } else {
      progress.value = withTiming(0, CLOSE_TIMING, (finished) => {
        if (finished) scheduleOnRN(finishClose);
      });
    }
    // grow only touches the shared value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, progress]);

  const handleShow = () => {
    shownRef.current = true;
    setCovered(true);
    if (openRef.current) grow();
  };
  // The shape is the round button again: show the real one, drop the Modal.
  function finishClose() {
    setCovered(false);
    setMounted(false);
  }
  const handleDismiss = () => {
    shownRef.current = false;
    onClosed();
  };

  // Android has no Modal onDismiss; the Modal is gone once unmounted.
  useEffect(() => {
    if (!mounted && Platform.OS !== 'ios') {
      shownRef.current = false;
      onClosed();
    }
  }, [mounted, onClosed]);

  const handleOpen = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpen();
  };

  // The shape: the button at 0, the card at 1. The spring's overshoot past 1
  // becomes a hint of scale instead of a card that is too big for its content.
  const shellStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      width: interpolate(p, [0, 1], [BUTTON_SIZE, cardWidth], Extrapolation.CLAMP),
      height: interpolate(p, [0, 1], [BUTTON_SIZE, cardHeight.value], Extrapolation.CLAMP),
      right: interpolate(p, [0, 1], [BUTTON_RIGHT, cardRight], Extrapolation.CLAMP),
      borderRadius: interpolate(p, [0, 1], [BUTTON_SIZE / 2, CARD_RADIUS], Extrapolation.CLAMP),
      shadowOpacity: interpolate(p, [0, 1], [0.08, isDark ? 0.5 : 0.14], Extrapolation.CLAMP),
      shadowRadius: interpolate(p, [0, 1], [12, 30], Extrapolation.CLAMP),
      shadowOffset: { width: 0, height: interpolate(p, [0, 1], [2, 10], Extrapolation.CLAMP) },
      transform: [{ scale: 1 + Math.max(0, p - 1) * 0.5 }],
    };
  });
  // The black button's edge is black too; the card's is the light border.
  const buttonFill = colors.text;
  const cardBorder = colors.border;
  const clipStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(progress.value, [0, 1], [BUTTON_SIZE / 2, CARD_RADIUS], Extrapolation.CLAMP),
    borderColor: interpolateColor(progress.value, [0, 0.35], [buttonFill, cardBorder]),
  }));
  // Solid like the button at the ends, glass like Slack's card in between.
  const fillStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.35], [1, 0], Extrapolation.CLAMP),
  }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.16], [1, 0], Extrapolation.CLAMP),
  }));
  // The contents follow once the shape is mostly there, and leave first.
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.55, 1], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(progress.value, [0.55, 1], [0.97, 1], Extrapolation.CLAMP) }],
  }));

  const icon = <Plus size={ICON_SIZE} color={colors.background} strokeWidth={2} />;

  return (
    <>
      <Pressable
        style={({ pressed }) => [
          styles.button,
          { bottom: buttonBottom },
          pressed && styles.buttonPressed,
          covered && styles.hidden,
        ]}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={buttonLabel}
        testID={buttonTestID}
      >
        {icon}
      </Pressable>

      <Modal
        visible={mounted}
        transparent
        animationType="none"
        onShow={handleShow}
        onRequestClose={onRequestClose}
        onDismiss={handleDismiss}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onRequestClose} accessibilityRole="button" />

        <Animated.View style={[styles.shell, { bottom }, shellStyle]}>
          <Animated.View style={[styles.clip, clipStyle]}>
            <BlurView
              style={StyleSheet.absoluteFill}
              tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
              intensity={90}
            />
            <View style={[StyleSheet.absoluteFill, styles.cardTint]} />
            <Animated.View style={[StyleSheet.absoluteFill, styles.fill, fillStyle]} />
            <Animated.View style={[styles.buttonIcon, iconStyle]} pointerEvents="none">
              {icon}
            </Animated.View>

            {/* Laid out at full card size from the start and anchored to the
                bottom right, so nothing reflows while the shape grows. */}
            <Animated.View
              style={[styles.content, { width: cardWidth }, contentStyle]}
              onLayout={(e) => {
                cardHeight.value = e.nativeEvent.layout.height;
              }}
            >
              {items.map((item) => (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={item.onPress}
                  accessibilityRole="button"
                  accessibilityHint={item.hint}
                  testID={item.testID}
                >
                  <View style={styles.tile}>{item.icon}</View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{item.title}</Text>
                    <Text style={styles.rowHint} numberOfLines={1}>{item.hint}</Text>
                  </View>
                </Pressable>
              ))}

              <Pressable
                style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
                onPress={primary.onPress}
                accessibilityRole="button"
                testID={primary.testID}
              >
                {primary.icon}
                <Text style={styles.primaryText}>{primary.label}</Text>
              </Pressable>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </Modal>
    </>
  );
}

const makeStyles = (c: ThemeColors, isDark: boolean) =>
  StyleSheet.create({
    // Floats just above the tab bar on the right, like Slack's compose button;
    // black (white in dark mode), like the app's primary buttons.
    button: {
      position: 'absolute',
      right: BUTTON_RIGHT,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: BUTTON_SIZE / 2,
      backgroundColor: c.text,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.text,
      alignItems: 'center',
      justifyContent: 'center',
      // The tab bar's shadow (FloatingTabBar's `shadow`), so the two sit together.
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 12,
      elevation: 6,
    },
    buttonPressed: { transform: [{ scale: 0.94 }] },
    hidden: { opacity: 0 },
    // The morphing shape; its size, position, corners and shadow are animated.
    shell: {
      position: 'absolute',
      transformOrigin: 'bottom right',
      shadowColor: '#000',
      elevation: 12,
    },
    // The border colour is animated (clipStyle).
    clip: {
      ...StyleSheet.absoluteFill,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
    },
    cardTint: { backgroundColor: isDark ? 'rgba(28,28,30,0.6)' : 'rgba(255,255,255,0.72)' },
    // The button's own colour, so the shape starts out exactly as the button.
    fill: { backgroundColor: c.text },
    buttonIcon: {
      position: 'absolute',
      right: (BUTTON_SIZE - ICON_SIZE) / 2,
      bottom: (BUTTON_SIZE - ICON_SIZE) / 2,
    },
    // Every action has the same shape (BUTTON_RADIUS corners); the rows only
    // show theirs while pressed.
    content: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      padding: 12,
      gap: 8,
      transformOrigin: 'bottom right',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: BUTTON_RADIUS,
      borderCurve: 'continuous',
    },
    rowPressed: { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(118,118,128,0.12)' },
    tile: { width: 24, alignItems: 'center' },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 16, fontWeight: '600', color: c.text },
    rowHint: { fontSize: 14, color: c.mutedForeground, marginTop: 1 },
    primary: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      height: 52,
      borderRadius: BUTTON_RADIUS,
      borderCurve: 'continuous',
      backgroundColor: c.text,
    },
    primaryPressed: { opacity: 0.85 },
    primaryText: { fontSize: 17, fontWeight: '600', color: c.background },
  });
