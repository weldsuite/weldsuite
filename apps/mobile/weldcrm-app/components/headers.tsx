/**
 * Screen headers that sit below the status bar and camera cutout.
 *
 * The app draws edge to edge on Android, so a header at the top of a screen has
 * to add the top safe-area inset itself; otherwise its title lands under the
 * clock and its buttons under the cutout.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';

interface TabHeaderProps {
  title: string;
  /** Buttons on the right, such as the add button. */
  right?: ReactNode;
  /** A control under the title row, such as a segmented switch. */
  children?: ReactNode;
}

/** Large title row for a tab screen. */
export function TabHeader({ title, right, children }: Readonly<TabHeaderProps>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.tabHeader,
        { paddingTop: insets.top + 12, backgroundColor: colors.background, borderBottomColor: colors.divider },
      ]}
    >
      <View style={styles.titleRow}>
        <Text style={[styles.tabTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
      {children}
    </View>
  );
}

interface StackHeaderProps {
  title: string;
  onBack: () => void;
  right?: ReactNode;
}

/** Back button, centred title and optional actions for a pushed screen. */
export function StackHeader({ title, onBack, right }: Readonly<StackHeaderProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.stackHeader,
        { paddingTop: insets.top + 4, backgroundColor: colors.background, borderBottomColor: colors.divider },
      ]}
    >
      <TouchableOpacity
        onPress={onBack}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel={t.common.back}
      >
        <ArrowLeft size={24} color={colors.text} />
      </TouchableOpacity>
      <Text style={[styles.stackTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.stackRight}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabHeader: { paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  tabTitle: { flex: 1, fontSize: 24, fontWeight: '700', letterSpacing: -0.3 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stackHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconButton: { padding: 8 },
  stackTitle: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center', marginHorizontal: 8 },
  stackRight: { minWidth: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
});
