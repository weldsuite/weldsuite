/**
 * The top bar of a create screen (Form.tsx), copied from WeldChat's
 * create screens (new channel, new category) so the two apps look the same:
 * a round close or back button on the left, the title centred on the screen,
 * and an optional pill for the screen's action on the right. The three
 * controls share one height so the row reads as one line.
 */
import { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { X, ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import type { Colors } from '@weldsuite/mobile-ui/constants/theme';

type ThemeColors = (typeof Colors)['light'];

const CONTROL_SIZE = 40;
/** Keeps a long title clear of the pill; the pill is at most ~108pt wide. */
const TITLE_INSET = 108;

export interface SheetHeaderAction {
  label: string;
  onPress: () => void;
  /** Gray until the screen has what it needs; black once it can go on. */
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}

export interface SheetHeaderProps {
  title: string;
  /** An X to leave the screen, or a chevron to go back a step. */
  leading?: 'close' | 'back';
  onLeadingPress: () => void;
  /** Read out for the round button ("Close", "Back"). */
  leadingLabel: string;
  action?: SheetHeaderAction;
  style?: StyleProp<ViewStyle>;
}

export function SheetHeader({
  title,
  leading = 'close',
  onLeadingPress,
  leadingLabel,
  action,
  style,
}: Readonly<SheetHeaderProps>) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const actionDisabled = !action || action.disabled || action.loading;

  return (
    <View style={[styles.header, style]}>
      {/* Centred on the screen, not between the two buttons, whatever they say. */}
      <View style={styles.titleWrap} pointerEvents="none">
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.iconBtn}
        onPress={onLeadingPress}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={leadingLabel}
        // The id the other screens' close and back buttons have, for the UI tests.
        testID="screen-close"
      >
        {leading === 'back' ? (
          <ChevronLeft size={22} color={colors.text} strokeWidth={2.2} style={styles.backIcon} />
        ) : (
          <X size={20} color={colors.text} strokeWidth={2.2} />
        )}
      </TouchableOpacity>
      {action && (
        <TouchableOpacity
          style={[styles.pill, actionDisabled && styles.pillDisabled]}
          onPress={action.onPress}
          disabled={actionDisabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ disabled: !!actionDisabled, busy: !!action.loading }}
          testID={action.testID}
        >
          {action.loading ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Text style={[styles.pillText, actionDisabled && styles.pillTextDisabled]}>{action.label}</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 10,
    },
    titleWrap: {
      position: 'absolute',
      left: TITLE_INSET,
      right: TITLE_INSET,
      top: 14,
      bottom: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { fontSize: 17, fontWeight: '600', color: c.text },
    iconBtn: {
      width: CONTROL_SIZE,
      height: CONTROL_SIZE,
      borderRadius: CONTROL_SIZE / 2,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // The chevron's point sits left of its box; nudge it to look centred.
    backIcon: { marginLeft: -2 },
    pill: {
      height: CONTROL_SIZE,
      minWidth: 80,
      paddingHorizontal: 18,
      borderRadius: CONTROL_SIZE / 2,
      backgroundColor: c.text,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pillDisabled: { backgroundColor: c.secondary },
    pillText: { fontSize: 16, fontWeight: '600', color: c.background },
    pillTextDisabled: { color: c.muted },
  });
