import { useState, type ComponentType } from "react";
import { View, Text, Pressable, Modal, StyleSheet } from "react-native";
import Animated, { SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  EllipsisVertical,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  SwitchCamera,
  VideoOff,
} from "lucide-react-native";
import { useTheme } from "@weldsuite/mobile-ui/contexts/ThemeContext";
import { VideoCameraIcon } from "@/components/icons/VideoCameraIcon";
import { useI18n } from "@/lib/i18n";

import type { ThemeColors } from "@/lib/theme-colors";

type IconType = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

/**
 * The call's control bar, as WeldMeet lays it out on a phone: microphone,
 * camera, More and a wide leave button — 48pt rounded squares, red while the
 * mic or camera is off.
 */
export function CallControls({
  audioEnabled,
  videoEnabled,
  showCamera = true,
  onToggleMic,
  onToggleCamera,
  onFlipCamera,
  onBackToChat,
  onLeave,
}: Readonly<{
  audioEnabled: boolean;
  videoEnabled: boolean;
  /** Voice calls have no video on screen, so no camera button or flip. */
  showCamera?: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onFlipCamera: () => void;
  onBackToChat: () => void;
  onLeave: () => void;
}>) {
  const { colors, theme } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [moreOpen, setMoreOpen] = useState(false);
  const off = theme === "dark" ? OFF_DARK : OFF_LIGHT;
  const styles = makeStyles(colors);

  const controlStyle = (on: boolean) => [
    styles.control,
    on ? styles.controlOn : { backgroundColor: off.bg },
  ];

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(12, insets.bottom) }]}>
      <Pressable
        style={({ pressed }) => [
          controlStyle(audioEnabled),
          pressed && styles.pressed,
        ]}
        onPress={onToggleMic}
        accessibilityRole="button"
        accessibilityLabel={
          audioEnabled ? t.inCall.turnOffMic : t.inCall.turnOnMic
        }
      >
        {audioEnabled ? (
          <Mic size={20} color={colors.text} strokeWidth={2} />
        ) : (
          <MicOff size={20} color={off.icon} strokeWidth={2} />
        )}
      </Pressable>

      {showCamera && (
        <Pressable
          style={({ pressed }) => [
            controlStyle(videoEnabled),
            pressed && styles.pressed,
          ]}
          onPress={onToggleCamera}
          accessibilityRole="button"
          accessibilityLabel={
            videoEnabled ? t.inCall.turnOffCamera : t.inCall.turnOnCamera
          }
        >
          {videoEnabled ? (
            <VideoCameraIcon size={22} color={colors.text} strokeWidth={1.5} />
          ) : (
            <VideoOff size={20} color={off.icon} strokeWidth={2} />
          )}
        </Pressable>
      )}

      <Pressable
        style={({ pressed }) => [
          styles.control,
          styles.controlOn,
          pressed && styles.pressed,
        ]}
        onPress={() => setMoreOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t.inCall.moreOptions}
      >
        <EllipsisVertical size={20} color={colors.text} strokeWidth={2} />
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.leave, pressed && styles.leavePressed]}
        onPress={onLeave}
        accessibilityRole="button"
        accessibilityLabel={t.inCall.leaveCall}
      >
        <View style={styles.hangup}>
          <Phone size={20} color="#fff" fill="#fff" strokeWidth={2} />
        </View>
      </Pressable>

      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        tiles={[
          ...(showCamera
            ? [
                {
                  icon: SwitchCamera,
                  label: t.inCall.flipCamera,
                  disabled: !videoEnabled,
                  onPress: onFlipCamera,
                },
              ]
            : []),
          {
            icon: MessageSquare,
            label: t.inCall.backToChat,
            onPress: onBackToChat,
          },
        ]}
        colors={colors}
      />
    </View>
  );
}

/** "More options" as a bottom sheet of large tiles, like WeldMeet's phone sheet. */
function MoreSheet({
  open,
  onClose,
  tiles,
  colors,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  tiles: {
    icon: IconType;
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }[];
  colors: ThemeColors;
}>) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel={t.common.cancel}
      />
      <Animated.View
        entering={SlideInDown.duration(260)}
        style={[styles.sheet, { paddingBottom: Math.max(16, insets.bottom) }]}
      >
        <View style={styles.handle} />
        <Text style={styles.sheetTitle}>{t.inCall.moreOptions}</Text>
        <View style={styles.tiles}>
          {tiles.map(({ icon: Icon, label, disabled, onPress }) => (
            <Pressable
              key={label}
              disabled={disabled}
              onPress={() => {
                onClose();
                onPress();
              }}
              style={({ pressed }) => [
                styles.tile,
                pressed && styles.tilePressed,
                disabled && styles.tileDisabled,
              ]}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
            >
              <Icon size={20} color={colors.text} strokeWidth={2} />
              <Text style={styles.tileLabel} numberOfLines={2}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Animated.View>
    </Modal>
  );
}

// Tailwind red-100 / red-500 (light) and red-500 at 20% / red-400 (dark).
const OFF_LIGHT = { bg: "#FEE2E2", icon: "#EF4444" };
const OFF_DARK = { bg: "rgba(239,68,68,0.2)", icon: "#F87171" };

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 8,
      backgroundColor: c.background,
    },
    control: {
      width: 48,
      height: 48,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    controlOn: {
      backgroundColor: c.secondary,
      borderWidth: 1,
      borderColor: c.border,
    },
    pressed: { opacity: 0.7 },
    leave: {
      width: 60,
      height: 48,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.destructive,
    },
    leavePressed: { opacity: 0.85 },
    hangup: { transform: [{ rotate: "135deg" }] },
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
      backgroundColor: c.background,
      paddingHorizontal: 16,
    },
    handle: {
      alignSelf: "center",
      width: 100,
      height: 8,
      borderRadius: 4,
      marginTop: 16,
      backgroundColor: c.secondary,
    },
    sheetTitle: {
      marginTop: 16,
      fontSize: 17,
      fontWeight: "600",
      color: c.text,
      textAlign: "center",
    },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 16 },
    tile: {
      width: "31.5%",
      minHeight: 72,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingHorizontal: 8,
      paddingVertical: 12,
      borderRadius: 12,
      backgroundColor: c.secondary,
    },
    tilePressed: { opacity: 0.7 },
    tileDisabled: { opacity: 0.5 },
    tileLabel: {
      fontSize: 12,
      fontWeight: "500",
      color: c.text,
      textAlign: "center",
    },
  });
