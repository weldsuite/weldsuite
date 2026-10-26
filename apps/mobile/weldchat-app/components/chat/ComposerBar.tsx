/**
 * The message composer from the chat screen, shared by every screen that
 * writes a message: the idle pill, the card it opens into while typing, and
 * the voice-recording pill. Each screen keeps its own state (text, focus,
 * sending) and decides which of the three to show; the "+" and the mic only
 * appear when the screen handles attachments and voice messages.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Image,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Extrapolation,
  FadeIn,
  interpolate,
  useAnimatedStyle,
  type DerivedValue,
} from 'react-native-reanimated';
import { useKeyboardHandler } from 'react-native-keyboard-controller';
import { scheduleOnRN } from 'react-native-worklets';
import { BlurView } from 'expo-blur';
import { getRandomBytes } from 'expo-crypto';
import { FileText, Plus, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ExpandIcon, MicIcon, SendArrowIcon } from '@/components/icons/ComposerIcons';
import { useI18n } from '@/lib/i18n';
import { hasMentionTokens, mentionLabel, mentionTokenRegex } from '@/lib/chat/mentions';
import type { RNFile } from '@/lib/chat/attachments';
import { mentionBadgeColors } from './MessageText';

import type { ThemeColors } from '@/lib/theme-colors';

export type BlurTint = 'dark' | 'light';

const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };
/** A header row at the top of the card (e.g. "Replying to …"), as in Discord. */
const COMPOSER_HEADER_HEIGHT = 40;
const NO_MEMBERS = new Map<string, string>();

function useComposerStyles() {
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const styles = useMemo(() => makeComposerStyles(colors, isDark), [colors, isDark]);
  const blurTint: BlurTint = isDark ? 'dark' : 'light';
  return { colors, styles, blurTint };
}

/**
 * Calls `onHide` as the keyboard starts to go down. The field reports its
 * blur, and iOS its "keyboard hidden" event, only ~0.2s after the keyboard
 * has visibly gone, so a composer waiting for those stays open a beat too
 * long. Pass a stable callback.
 */
export function useKeyboardHide(onHide: () => void) {
  useKeyboardHandler(
    {
      onStart: (e) => {
        'worklet';
        if (e.height === 0) scheduleOnRN(onHide);
      },
    },
    [onHide],
  );
}

/** The bar's side insets: the idle pill's, and the card's while typing. */
const BAR_IDLE_INSET = 38;
const BAR_OPEN_INSET = 12;
function barIdleBottom(bottomInset: number): number {
  'worklet';
  return Math.max(bottomInset + 4, 12);
}

/**
 * The bar's insets around the composer: a pill 38pt in from the sides while
 * idle, a card 12pt in while typing, moving with `open` (0..1, usually the
 * keyboard's progress). `heldOpen` keeps it a card with the keyboard down,
 * e.g. while there is still text in the field.
 */
export function useComposerBarStyle(
  open: DerivedValue<number>,
  heldOpen: DerivedValue<number>,
  bottomInset: number,
) {
  return useAnimatedStyle(() => {
    const value = Math.max(open.value, heldOpen.value);
    return {
      paddingHorizontal: interpolate(value, [0, 1], [BAR_IDLE_INSET, BAR_OPEN_INSET], Extrapolation.CLAMP),
      paddingBottom: interpolate(
        value,
        [0, 1],
        [barIdleBottom(bottomInset), BAR_OPEN_INSET + bottomInset],
        Extrapolation.CLAMP,
      ),
    };
  });
}

/**
 * The bar around the composer. The idle pill sits in a plain view with its
 * fixed insets; only the card and the recording bar sit in the animated one.
 * The pill takes over while the keyboard goes down, and mounted inside the
 * animated bar then, it was laid out for the wrong width for a few frames.
 */
export function ComposerBarFrame({
  idle,
  animatedStyle,
  bottomInset,
  style,
  children,
}: Readonly<{
  idle: boolean;
  animatedStyle: ReturnType<typeof useComposerBarStyle>;
  bottomInset: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}>) {
  if (idle) {
    return (
      <View style={[style, { paddingHorizontal: BAR_IDLE_INSET, paddingBottom: barIdleBottom(bottomInset) }]}>
        {children}
      </View>
    );
  }
  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}

/** Uniform random number in [0, 1) from the platform CSPRNG. */
function randomUnit(): number {
  return getRandomBytes(1)[0] / 256;
}

/** Render input text with inline mention badges (overlay on TextInput) */
function renderInputWithBadges(text: string, members: Map<string, string>, colors: ThemeColors) {
  const mentionRegex = mentionTokenRegex();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={`t${match.index}`} style={{ fontSize: 16, color: colors.text }}>
          {text.substring(lastIndex, match.index)}
        </Text>
      );
    }
    const name = mentionLabel(match[1], members);
    parts.push(
      <Text key={`m${match.index}`} style={{ fontSize: 15, fontWeight: '700', ...mentionBadgeColors(colors), borderRadius: 4, paddingHorizontal: 3, overflow: 'hidden' }}>@{name}</Text>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <Text key="end" style={{ fontSize: 16, color: colors.text }}>
        {text.substring(lastIndex)}
      </Text>
    );
  }

  return <Text style={{ fontSize: 16, lineHeight: 22, color: colors.text }}>{parts}</Text>;
}

/** Live audio waveform driven by the recorder's meter (dB). Bars shift left
 *  each tick; the newest bar is sized by the current input level. Silent
 *  input → all bars collapse to a flat baseline. */
function Waveform({ active, color, level }: Readonly<{ active: boolean; color: string; level: number }>) {
  const BAR_COUNT = 40;
  // Each bar carries a stable id so React keeps the same element as bars shift left.
  const nextBarId = useRef(BAR_COUNT);
  const [bars, setBars] = useState<{ id: number; value: number }[]>(() =>
    Array.from({ length: BAR_COUNT }, (_, id) => ({ id, value: 0 })),
  );
  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    if (!active) {
      setBars((prev) => prev.map((bar) => ({ id: bar.id, value: 0 })));
      return;
    }
    const id = setInterval(() => {
      setBars((prev) => {
        // Map dB (-60..0) to 0..1; ignore anything below -60 (effectively silence).
        const db = levelRef.current;
        const norm = Math.max(0, Math.min(1, (db + 60) / 60));
        // Add a touch of jitter so the newest bar still feels alive, but only
        // proportional to the current level (so silence stays flat).
        const jitter = (randomUnit() - 0.5) * 0.15 * norm;
        const next = Math.max(0, Math.min(1, norm + jitter));
        return [...prev.slice(1), { id: nextBarId.current++, value: next }];
      });
    }, 60);
    return () => clearInterval(id);
  }, [active]);

  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 32, paddingHorizontal: 4 }}>
      {bars.map(({ id, value }) => (
        <View
          key={id}
          style={{
            width: 2,
            height: Math.max(2, value * 22),
            borderRadius: 1,
            backgroundColor: color,
            opacity: 0.55,
          }}
        />
      ))}
    </View>
  );
}

function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The composer while a voice message is recorded: same pill as the idle
 * composer, with delete on the left, then the live waveform and timer, and
 * send on the right (a spinner while the recording uploads).
 */
export function RecordingPill({
  meteringDb,
  durationMs,
  sending,
  onCancel,
  onSend,
}: Readonly<{
  meteringDb: number;
  durationMs: number;
  sending: boolean;
  onCancel: () => void;
  onSend: () => void;
}>) {
  const { t } = useI18n();
  const { colors, styles } = useComposerStyles();
  return (
    <Animated.View style={styles.composerShadowCollapsed} entering={FadeIn.duration(180)}>
      <View style={styles.recordingPill}>
        <TouchableOpacity
          style={styles.composerPlusBtn}
          onPress={onCancel}
          disabled={sending}
          activeOpacity={0.5}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t.composer.deleteRecording}
          testID="composer-recording-cancel"
        >
          <View style={[styles.recordingStop, sending && styles.recordingStopDisabled]} />
        </TouchableOpacity>
        <Waveform active={!sending} color={colors.text} level={meteringDb} />
        <Text style={styles.recordingTime}>{formatRecordingTime(durationMs)}</Text>
        <TouchableOpacity
          style={styles.composerSolidBtn}
          onPress={onSend}
          disabled={sending}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t.composer.send}
          accessibilityState={{ disabled: sending, busy: sending }}
          testID="composer-recording-send"
        >
          <SendButtonIcon uploading={sending} colors={colors} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

function SendButtonIcon({
  uploading,
  colors,
}: Readonly<{ uploading: boolean; colors: ThemeColors }>) {
  if (uploading) return <ActivityIndicator size="small" color={colors.background} />;
  return <SendArrowIcon size={24} color={colors.background} />;
}

/** Mic (records a voice message) + the solid send button, right of the bar. */
function ComposerActions({
  uploading,
  canSend,
  onSend,
  onStartRecording,
}: Readonly<{
  uploading: boolean;
  canSend: boolean;
  onSend: () => void;
  onStartRecording?: () => void;
}>) {
  const { t } = useI18n();
  const { colors, styles } = useComposerStyles();
  const sendDisabled = uploading || !canSend;
  return (
    <View style={styles.composerActionsRight}>
      {onStartRecording && (
        <TouchableOpacity
          style={styles.composerMicBtn}
          onPress={onStartRecording}
          activeOpacity={0.5}
          accessibilityRole="button"
          accessibilityLabel={t.composer.recordVoice}
        >
          {/* 19pt tall, with the same ~1.9pt stroke as the plus. */}
          <MicIcon size={21} color={colors.text} strokeWidth={2.15} />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        style={[styles.composerSolidBtn, sendDisabled && styles.sendBtnDisabled]}
        onPress={onSend}
        disabled={sendDisabled}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={t.composer.send}
        accessibilityState={{ disabled: sendDisabled }}
      >
        <SendButtonIcon uploading={uploading} colors={colors} />
      </TouchableOpacity>
    </View>
  );
}

// The text field shows up to eight lines, then scrolls; the expand button
// (from three lines) lets it grow to most of the space above the keyboard.
const COMPOSER_LINE_HEIGHT = 22;
const COMPOSER_MAX_LINES = 8;
const COMPOSER_EXPAND_FROM_LINES = 3;

export interface ExpandedComposerProps {
  input: string;
  placeholder: string;
  /** userId → name, for the @mention badges in the field. */
  members?: Map<string, string>;
  uploading: boolean;
  canSend: boolean;
  inputRef: React.RefObject<TextInput | null>;
  // The field's own scroll state; a screen that doesn't follow it can leave
  // these out.
  inputScrollRef?: React.RefObject<ScrollView | null>;
  inputContentHeightRef?: React.RefObject<number>;
  inputUserScrollingRef?: React.RefObject<boolean>;
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Leave out to hide the "+" (no attachments here). */
  onAttach?: () => void;
  onSend: () => void;
  /** A row inside the card, above the text (e.g. what is being replied to). */
  header?: React.ReactNode;
}

export function ExpandedComposer({
  input,
  placeholder,
  members = NO_MEMBERS,
  uploading,
  canSend,
  inputRef,
  inputScrollRef: inputScrollRefProp,
  inputContentHeightRef: inputContentHeightRefProp,
  inputUserScrollingRef: inputUserScrollingRefProp,
  onChangeText,
  onFocus,
  onBlur,
  onAttach,
  onSend,
  header,
}: Readonly<ExpandedComposerProps>) {
  const { t } = useI18n();
  const { colors, styles, blurTint } = useComposerStyles();
  const ownScrollRef = useRef<ScrollView>(null);
  const ownContentHeightRef = useRef(0);
  const ownUserScrollingRef = useRef(false);
  const inputScrollRef = inputScrollRefProp ?? ownScrollRef;
  const inputContentHeightRef = inputContentHeightRefProp ?? ownContentHeightRef;
  const inputUserScrollingRef = inputUserScrollingRefProp ?? ownUserScrollingRef;
  const { height: windowHeight } = useWindowDimensions();
  const hasMentions = hasMentionTokens(input);
  const [canExpand, setCanExpand] = useState(false);
  const [tall, setTall] = useState(false);
  const maxInputHeight = tall
    ? Math.round(windowHeight * 0.4)
    : COMPOSER_LINE_HEIGHT * COMPOSER_MAX_LINES;
  return (
    <Animated.View style={styles.composerShadow} entering={FadeIn.duration(220)}>
      <View style={styles.inputContainer}>
        <BlurView
          intensity={100}
          tint={blurTint}
          blurMethod="dimezisBlurView"
          style={styles.composerGlass}
          pointerEvents="none"
        />
        {header ? <View style={styles.composerHeader}>{header}</View> : null}
        {/* Text input area */}
        <ScrollView
          ref={inputScrollRef}
          style={[styles.inputWrapper, header ? styles.inputWrapperUnderHeader : null, { maxHeight: maxInputHeight }]}
          contentContainerStyle={styles.inputWrapperContent}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator
          nestedScrollEnabled
          overScrollMode="never"
          decelerationRate="normal"
          onScrollBeginDrag={() => { inputUserScrollingRef.current = true; }}
          onScrollEndDrag={(e) => {
            const v = e.nativeEvent.velocity?.y ?? 0;
            if (Math.abs(v) < 0.05) {
              inputUserScrollingRef.current = false;
            }
          }}
          onMomentumScrollEnd={() => { inputUserScrollingRef.current = false; }}
          onContentSizeChange={(_, h) => {
            const grew = h > inputContentHeightRef.current;
            inputContentHeightRef.current = h;
            setCanExpand(h >= COMPOSER_LINE_HEIGHT * COMPOSER_EXPAND_FROM_LINES);
            if (grew && !inputUserScrollingRef.current) {
              inputScrollRef.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          <TextInput
            ref={inputRef}
            style={[styles.input, hasMentions && styles.inputTransparent]}
            value={input}
            onChangeText={onChangeText}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder={placeholder}
            placeholderTextColor={colors.placeholder}
            multiline
            autoFocus
            scrollEnabled={false}
            textAlignVertical="top"
          />
          {hasMentions && (
            <View style={styles.inputOverlay} pointerEvents="none">
              {renderInputWithBadges(input, members, colors)}
            </View>
          )}
        </ScrollView>

        {(canExpand || tall) && (
          <TouchableOpacity
            style={[styles.composerExpandBtn, header ? styles.composerExpandBtnUnderHeader : null]}
            onPress={() => setTall((v) => !v)}
            activeOpacity={0.5}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={tall ? t.composer.collapseInput : t.composer.expandInput}
          >
            <ExpandIcon size={24} color={colors.muted} collapse={tall} />
          </TouchableOpacity>
        )}

        {/* Action row, as in the ChatGPT composer: "+" on the left, mic and
            the solid send button on the right. */}
        <View style={styles.inputActions}>
          {onAttach ? (
            <TouchableOpacity
              style={styles.composerPlusBtn}
              onPress={onAttach}
              activeOpacity={0.5}
              hitSlop={HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel={t.composer.attach}
            >
              <Plus size={28} color={colors.text} strokeWidth={1.7} />
            </TouchableOpacity>
          ) : (
            <View />
          )}
          {/* While typing there is only send; the mic is on the idle pill. */}
          <ComposerActions uploading={uploading} canSend={canSend} onSend={onSend} />
        </View>
      </View>
    </Animated.View>
  );
}

export function CollapsedComposer({
  placeholder,
  onAttach,
  onExpand,
  onStartRecording,
}: Readonly<{
  placeholder: string;
  onAttach?: () => void;
  onExpand: () => void;
  onStartRecording?: () => void;
}>) {
  const { t } = useI18n();
  const { colors, styles, blurTint } = useComposerStyles();
  // No fade-in: the pill takes over from the card in place, and a fade from
  // nothing there reads as the field flickering away.
  return (
    <View style={styles.composerShadowCollapsed}>
      <View style={styles.inputContainerCollapsed}>
        <BlurView
          intensity={100}
          tint={blurTint}
          blurMethod="dimezisBlurView"
          style={styles.composerGlass}
          pointerEvents="none"
        />
        {onAttach && (
          <TouchableOpacity
            style={styles.composerPlusBtn}
            onPress={onAttach}
            activeOpacity={0.5}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t.composer.attach}
          >
            <Plus size={28} color={colors.text} strokeWidth={1.7} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.collapsedInputArea, !onAttach && styles.collapsedInputAreaNoAttach]}
          onPress={onExpand}
          activeOpacity={0.7}
        >
          <Text style={styles.collapsedPlaceholder} numberOfLines={1}>
            {placeholder}
          </Text>
        </TouchableOpacity>
        {/* Nothing to send yet: the send button shows dimmed. */}
        <ComposerActions
          uploading={false}
          canSend={false}
          onSend={() => {}}
          onStartRecording={onStartRecording}
        />
      </View>
    </View>
  );
}

/**
 * The files picked with "+", above the composer until the message is sent, as
 * Discord shows them: a thumbnail per photo (a file tile otherwise) with a
 * round ✕ on its corner.
 */
export function PendingFiles({
  files,
  onRemove,
}: Readonly<{ files: RNFile[]; onRemove: (index: number) => void }>) {
  const { t } = useI18n();
  const { colors, styles } = useComposerStyles();
  if (files.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.pendingFiles}
      contentContainerStyle={styles.pendingFilesContent}
    >
      {files.map((f, i) => (
        <View key={f.uri} style={styles.pendingTile}>
          {f.mimeType.startsWith('image/') ? (
            <Image source={{ uri: f.uri }} style={styles.pendingThumb} />
          ) : (
            <View style={[styles.pendingThumb, styles.pendingFileThumb]}>
              <FileText size={20} color={colors.mutedForeground} strokeWidth={1.8} />
              <Text style={styles.pendingFileName} numberOfLines={1}>{f.name}</Text>
            </View>
          )}
          <TouchableOpacity
            style={styles.pendingRemove}
            onPress={() => onRemove(i)}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t.composer.removeAttachment}
          >
            <X size={12} color={styles.pendingRemoveIcon.color} strokeWidth={3} />
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

// The composer's glass: a slightly off-white fill (lighter while idle than
// while typing) inside a very light gray border. Translucent, so the
// BlurView behind it frosts the messages.
const COMPOSER_GLASS = {
  light: { idle: 'rgba(253,253,253,0.92)', typing: 'rgba(250,250,250,0.92)', rim: '#F2F2F2' },
  dark: { idle: 'rgba(28,28,30,0.92)', typing: 'rgba(28,28,30,0.92)', rim: 'rgba(255,255,255,0.14)' },
};

const makeComposerStyles = (c: ThemeColors, isDark: boolean) =>
  StyleSheet.create({
    inputContainer: {
      borderRadius: 24,
      borderCurve: 'continuous',
      // Frosted glass (see COMPOSER_GLASS) over a BlurView material, clipped
      // to the rounded corners. The shadow lives on the composerShadow
      // wrapper, since overflow:hidden here would clip it away.
      borderWidth: 1,
      borderColor: COMPOSER_GLASS[isDark ? 'dark' : 'light'].rim,
      backgroundColor: COMPOSER_GLASS[isDark ? 'dark' : 'light'].typing,
      overflow: 'hidden',
    },
    composerShadow: {
      borderRadius: 24,
      borderCurve: 'continuous',
      shadowColor: '#000',
      shadowOpacity: 0.13,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: 4 },
    },
    inputContainerCollapsed: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 48,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: COMPOSER_GLASS[isDark ? 'dark' : 'light'].rim,
      backgroundColor: COMPOSER_GLASS[isDark ? 'dark' : 'light'].idle,
      overflow: 'hidden',
      // 1pt less than the measured insets: the rim takes that point.
      paddingLeft: 5,
      paddingRight: 7,
    },
    composerShadowCollapsed: {
      borderRadius: 24,
      shadowColor: '#000',
      shadowOpacity: 0.13,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: 4 },
    },
    composerGlass: {
      ...StyleSheet.absoluteFill,
    },
    collapsedInputArea: {
      flex: 1,
      height: 48,
      marginLeft: 7,
      justifyContent: 'center',
    },
    // No "+": the placeholder starts where the typed text will (15pt in).
    collapsedInputAreaNoAttach: { marginLeft: 10 },
    collapsedPlaceholder: {
      fontSize: 16, color: c.placeholder,
    },
    // The card's insets below are 1pt less than measured: the rim takes it.
    inputWrapper: { marginTop: 13 },
    inputWrapperContent: { position: 'relative' },
    composerHeader: {
      height: COMPOSER_HEADER_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 15,
      paddingRight: 10,
    },
    inputWrapperUnderHeader: { marginTop: 2 },
    composerExpandBtnUnderHeader: { top: COMPOSER_HEADER_HEIGHT + 2 },
    input: {
      fontSize: 16, lineHeight: 22, color: c.text,
      paddingTop: 0, paddingBottom: 0, paddingLeft: 15, paddingRight: 43,
      minHeight: 24,
    },
    inputTransparent: { color: 'transparent' },
    inputOverlay: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      paddingLeft: 15, paddingRight: 43,
    },
    // Centred on the first line, 24pt in from the right edge.
    composerExpandBtn: {
      position: 'absolute', top: 12, right: 11,
      width: 24, height: 24,
      justifyContent: 'center', alignItems: 'center',
    },
    inputActions: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      height: 32,
      marginTop: 15.5, marginBottom: 6.5,
      paddingLeft: 5, paddingRight: 7,
    },
    composerPlusBtn: {
      width: 36, height: 32,
      justifyContent: 'center', alignItems: 'center',
    },
    composerActionsRight: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    composerMicBtn: {
      width: 40, height: 32,
      justifyContent: 'center', alignItems: 'center',
    },
    composerSolidBtn: {
      width: 32, height: 32, borderRadius: 16,
      backgroundColor: c.text,
      justifyContent: 'center', alignItems: 'center',
    },
    sendBtnDisabled: {
      opacity: 0.25,
    },
    // Same pill as inputContainerCollapsed, so recording doesn't move a thing.
    recordingPill: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 48,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: COMPOSER_GLASS[isDark ? 'dark' : 'light'].rim,
      backgroundColor: COMPOSER_GLASS[isDark ? 'dark' : 'light'].idle,
      paddingLeft: 5,
      paddingRight: 7,
    },
    // Filled square at the left of the recording bar: discards the recording.
    recordingStop: {
      width: 14, height: 14, borderRadius: 3.5,
      backgroundColor: c.text,
    },
    recordingStopDisabled: { backgroundColor: c.muted },
    // 60pt tiles 4pt in from the composer card, 12pt above it; the top
    // padding leaves room for the ✕ that sticks out over the corner.
    pendingFiles: { flexGrow: 0 },
    pendingFilesContent: { gap: 14, paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 12 },
    pendingTile: { width: 60, height: 60 },
    pendingThumb: {
      width: 60, height: 60, borderRadius: 12,
      backgroundColor: c.secondary,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    pendingFileThumb: { alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 6 },
    pendingFileName: { fontSize: 10, color: c.mutedForeground, textAlign: 'center' },
    pendingRemove: {
      position: 'absolute', top: -7, right: -6,
      width: 24, height: 24, borderRadius: 12,
      borderWidth: 2, borderColor: c.background,
      backgroundColor: isDark ? '#4E5058' : '#D4D7DC',
      alignItems: 'center', justifyContent: 'center',
    },
    pendingRemoveIcon: { color: isDark ? '#FFFFFF' : '#1F2023' },
    recordingTime: {
      fontSize: 15, color: c.text,
      fontVariant: ['tabular-nums'],
      textAlign: 'right',
      marginLeft: 6, marginRight: 10,
      minWidth: 34,
    },
  });
