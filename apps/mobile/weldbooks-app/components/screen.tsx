/**
 * Screen chrome shared by every WeldBooks route.
 *
 * `ScreenHeader` mirrors the platform's WeldBooks header: a hairline-separated
 * bar with an optional back affordance, a title/subtitle stack, and an actions
 * slot on the right. `Screen` pairs it with the safe-area container so routes
 * only describe their content.
 */

import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  /** Shows a back chevron. Defaults to true on any screen given an onBack. */
  onBack?: () => void;
  showBack?: boolean;
  /** Rendered right-aligned — usually one or two IconButtons. */
  actions?: React.ReactNode;
  /** Rendered full-width beneath the title row (search bars, filter chips). */
  below?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  showBack,
  actions,
  below,
  style,
}: ScreenHeaderProps) {
  const { colors } = useTheme();
  const router = useRouter();
  const withBack = showBack ?? onBack !== undefined;

  return (
    <View style={[styles.header, { borderBottomColor: colors.border }, style]}>
      <View style={styles.headerRow}>
        {withBack ? (
          <IconButton
            icon={<ChevronLeft size={24} color={colors.text} />}
            accessibilityLabel="Go back"
            onPress={onBack ?? (() => router.back())}
            style={styles.back}
          />
        ) : null}
        <View style={styles.titles}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {actions ? <View style={styles.actions}>{actions}</View> : null}
      </View>
      {below ? <View style={styles.below}>{below}</View> : null}
    </View>
  );
}

export interface ScreenProps {
  children: React.ReactNode;
  /** Omit to render a screen with no header (e.g. the camera modal). */
  header?: React.ReactNode;
  /** Tab screens already sit inside the tab bar's safe area. */
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  style?: StyleProp<ViewStyle>;
}

export function Screen({ children, header, edges = ['top'], style }: ScreenProps) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      edges={edges}
      style={[styles.screen, { backgroundColor: colors.background }, style]}
    >
      {header}
      {children}
    </SafeAreaView>
  );
}

/** Small uppercase label that opens a group of rows, as on the platform. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{children}</Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 8,
    gap: 4,
  },
  back: { marginLeft: -4 },
  titles: { flex: 1, paddingHorizontal: 8, justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  subtitle: { fontSize: 13, marginTop: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  below: { paddingHorizontal: 16, paddingTop: 4 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 20,
    paddingHorizontal: 16,
  },
});
