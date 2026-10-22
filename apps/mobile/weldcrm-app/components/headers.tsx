/**
 * Screen headers, styled like WeldFlow's: a large title on tab screens, a
 * back chevron and compact title on pushed screens, actions in a rounded pill,
 * and no hairline under the header.
 *
 * The app draws edge to edge on Android, so a header at the top of a screen
 * adds the top safe-area inset itself; otherwise its title lands under the
 * clock and its buttons under the cutout.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { useI18n } from '@/lib/i18n';

interface TabHeaderProps {
  title: string;
  /** Buttons on the right, such as the add button. */
  right?: ReactNode;
  /** Controls under the title row, such as a search bar and filter chips. */
  children?: ReactNode;
}

/** Actions grouped in a pill, the way WeldFlow's headers show them. */
function ActionPill({ children }: Readonly<{ children: ReactNode }>) {
  const { colors } = useTheme();
  return <View style={[styles.actionPill, { backgroundColor: colors.secondary }]}>{children}</View>;
}

/** Large title row for a tab screen. */
export function TabHeader({ title, right, children }: Readonly<TabHeaderProps>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.tabHeader, { paddingTop: insets.top + 8, backgroundColor: colors.background }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.tabTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {right ? <ActionPill>{right}</ActionPill> : null}
      </View>
      {children ? <View style={styles.below}>{children}</View> : null}
    </View>
  );
}

interface StackHeaderProps {
  title: string;
  onBack: () => void;
  right?: ReactNode;
}

/** Back chevron, compact title and optional actions for a pushed screen. */
export function StackHeader({ title, onBack, right }: Readonly<StackHeaderProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.stackHeader, { paddingTop: insets.top + 4, backgroundColor: colors.background }]}>
      <IconButton
        icon={<ChevronLeft size={24} color={colors.text} />}
        accessibilityLabel={t.common.back}
        onPress={onBack}
        style={styles.back}
      />
      <Text style={[styles.stackTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {right ? <ActionPill>{right}</ActionPill> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tabHeader: { paddingBottom: 4 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
  },
  tabTitle: { flex: 1, fontSize: 26, fontWeight: '600', lineHeight: 32, letterSpacing: -0.4 },
  below: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 10 },
  stackHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 8,
    paddingBottom: 4,
    gap: 4,
  },
  back: { marginLeft: -4 },
  stackTitle: { flex: 1, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  actionPill: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 2, minHeight: 40, gap: 2 },
});
