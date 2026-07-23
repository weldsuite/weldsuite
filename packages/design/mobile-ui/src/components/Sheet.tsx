import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children?: React.ReactNode;
  /** Fraction of screen height for the sheet (0–1). @default 0.5 */
  heightRatio?: number;
  style?: StyleProp<ViewStyle>;
}

const SCREEN_HEIGHT = Dimensions.get('window').height;
const ANIMATION_DURATION = 280;

export function Sheet({
  visible,
  onClose,
  title,
  children,
  heightRatio = 0.5,
  style,
}: SheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const sheetHeight = SCREEN_HEIGHT * Math.min(Math.max(heightRatio, 0.1), 1);
  const translateY = useRef(new Animated.Value(sheetHeight)).current;

  useEffect(() => {
    if (visible) {
      Animated.timing(translateY, {
        toValue: 0,
        duration: ANIMATION_DURATION,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(translateY, {
        toValue: sheetHeight,
        duration: ANIMATION_DURATION,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, sheetHeight, translateY]);

  const handleClose = () => {
    Animated.timing(translateY, {
      toValue: sheetHeight,
      duration: ANIMATION_DURATION,
      useNativeDriver: true,
    }).start(() => {
      onClose();
    });
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={handleClose}>
        <View style={[styles.overlay, { backgroundColor: colors.overlay }]}>
          <TouchableWithoutFeedback>
            <Animated.View
              style={[
                styles.sheet,
                {
                  backgroundColor: colors.card,
                  maxHeight: sheetHeight,
                  paddingBottom: insets.bottom > 0 ? insets.bottom : Spacing.lg,
                  transform: [{ translateY }],
                },
                style,
              ]}
            >
              {/* Grabber */}
              <View style={styles.grabberRow}>
                <View style={[styles.grabber, { backgroundColor: colors.border }]} />
              </View>

              {/* Title row */}
              {(title != null) && (
                <View style={styles.titleRow}>
                  <Text style={[styles.titleText, { color: colors.text }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <Pressable
                    onPress={handleClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.closeButton,
                      { opacity: pressed ? 0.6 : 1 },
                    ]}
                  >
                    <X size={20} color={colors.mutedForeground} />
                  </Pressable>
                </View>
              )}

              {/* Content */}
              <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {children}
              </ScrollView>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

export default Sheet;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Radii.xl,
    borderTopRightRadius: Radii.xl,
    overflow: 'hidden',
  },
  grabberRow: {
    alignItems: 'center',
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: Radii.full,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  titleText: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
  },
  closeButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.lg,
  },
});
