import { useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  Animated,
  PanResponder,
  Dimensions,
  Easing,
} from 'react-native';
import { Reply, MessageSquare, Pin, PinOff, Smile, Copy, Trash2, Bookmark, Pencil } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '🙏', '🔥'];
const SCREEN_HEIGHT = Dimensions.get('window').height;

interface MessageActionsProps {
  visible: boolean;
  message: any;
  onClose: () => void;
  onReply: () => void;
  onReact: () => void;
  onThread: () => void;
  onPin: () => void;
  onCopy: () => void;
  onQuickReact?: (emoji: string) => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onSave?: () => void;
  isOwnMessage?: boolean;
}

export function MessageActions({
  visible,
  message,
  onClose,
  onReply,
  onReact,
  onThread,
  onPin,
  onCopy,
  onQuickReact,
  onDelete,
  onEdit,
  onSave,
  isOwnMessage,
}: MessageActionsProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.bottom), [colors, insets.bottom]);

  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      translateY.setValue(SCREEN_HEIGHT);
      backdropOpacity.setValue(0);
      Animated.parallel([
        // Ease-out cubic: glides up quickly then decelerates into place — the
        // clean, no-bounce settle used by Slack/Discord-style sheets.
        Animated.timing(translateY, {
          toValue: 0,
          duration: 340,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 260,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SCREEN_HEIGHT,
        duration: 260,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 220,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => onClose());
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 8,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) {
          translateY.setValue(g.dy);
        }
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 80 || g.vy > 0.5) {
          dismiss();
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            damping: 25,
            stiffness: 300,
          }).start();
        }
      },
    })
  ).current;

  if (!visible) return null;

  const isPinned = message?.isPinned;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
      </Animated.View>
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY }] }]}
        {...panResponder.panHandlers}
      >
        {/* Drag handle */}
        <View style={styles.handleBar}>
          <View style={styles.handle} />
        </View>

        {/* Quick emoji reactions */}
        <View style={styles.emojiRow}>
          {QUICK_EMOJIS.map((emoji) => (
            <TouchableOpacity
              key={emoji}
              style={styles.emojiBtn}
              onPress={() => { onQuickReact?.(emoji); dismiss(); }}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.emojiBtn}
            onPress={() => { onReact(); dismiss(); }}
          >
            <Smile size={22} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.divider} />

        {/* Actions */}
        <Pressable style={({ pressed }) => [styles.action, pressed && styles.actionPressed]} onPress={() => { onReply(); dismiss(); }}>
          <Reply size={20} color={colors.textPrimary} />
          <Text style={styles.actionText}>Reply</Text>
        </Pressable>

        <Pressable style={({ pressed }) => [styles.action, pressed && styles.actionPressed]} onPress={() => { onThread(); dismiss(); }}>
          <MessageSquare size={20} color={colors.textPrimary} />
          <Text style={styles.actionText}>Reply in Thread</Text>
        </Pressable>

        <Pressable style={({ pressed }) => [styles.action, pressed && styles.actionPressed]} onPress={() => { onCopy(); dismiss(); }}>
          <Copy size={20} color={colors.textPrimary} />
          <Text style={styles.actionText}>Copy Text</Text>
        </Pressable>

        <Pressable style={({ pressed }) => [styles.action, pressed && styles.actionPressed]} onPress={() => { onPin(); dismiss(); }}>
          {isPinned ? <PinOff size={20} color={colors.textPrimary} /> : <Pin size={20} color={colors.textPrimary} />}
          <Text style={styles.actionText}>{isPinned ? 'Unpin' : 'Pin Message'}</Text>
        </Pressable>

        <Pressable style={({ pressed }) => [styles.action, pressed && styles.actionPressed]} onPress={() => { onSave?.(); dismiss(); }}>
          <Bookmark size={20} color={colors.textPrimary} />
          <Text style={styles.actionText}>Save Message</Text>
        </Pressable>

        {isOwnMessage && message?.type !== 'system' && onEdit && (
          <Pressable style={({ pressed }) => [styles.action, pressed && styles.actionPressed]} onPress={() => { onEdit(); dismiss(); }}>
            <Pencil size={20} color={colors.textPrimary} />
            <Text style={styles.actionText}>Edit Message</Text>
          </Pressable>
        )}

        {isOwnMessage && onDelete && (
          <>
            <View style={styles.divider} />
            <Pressable style={({ pressed }) => [styles.action, pressed && styles.actionPressed]} onPress={() => { onDelete(); dismiss(); }}>
              <Trash2 size={20} color={colors.danger} />
              <Text style={[styles.actionText, { color: colors.danger }]}>Delete</Text>
            </Pressable>
          </>
        )}
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ColorScheme, bottomInset: number) =>
  StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheet: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: c.bgPrimary,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
      paddingBottom: 8 + bottomInset,
    },
    handleBar: {
      alignItems: 'center',
      paddingTop: 8,
      paddingBottom: 6,
    },
    handle: {
      width: 36,
      height: 5,
      borderRadius: 3,
      backgroundColor: c.bgAccent,
    },
    emojiRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingBottom: 12,
      gap: 8,
    },
    emojiBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.bgSecondary,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emoji: { fontSize: 22 },
    divider: {
      height: 1,
      backgroundColor: c.bgTertiary,
      marginHorizontal: 16,
      marginVertical: 4,
    },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingVertical: 13,
      paddingHorizontal: 20,
    },
    actionPressed: { backgroundColor: c.bgTertiary },
    actionText: { fontSize: 16, color: c.textPrimary },
  });
