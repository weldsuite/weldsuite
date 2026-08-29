/**
 * Screen chrome shared by every WeldDesk route.
 *
 * Tab screens use a large messaging-app title and an optional pill of icon
 * actions — the same chrome as WeldBooks' floating bottom nav.
 */

import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { useI18n } from '@/lib/i18n';

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  showBack?: boolean;
  actions?: React.ReactNode;
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
  const { t } = useI18n();
  const withBack = showBack ?? onBack !== undefined;
  const large = !withBack;

  return (
    <View style={[styles.header, style]}>
      <View style={[styles.headerRow, large && styles.headerRowLarge]}>
        {withBack ? (
          <IconButton
            icon={<ChevronLeft size={24} color={colors.text} />}
            accessibilityLabel={t.screen.goBack}
            onPress={onBack ?? (() => router.back())}
            style={styles.back}
          />
        ) : null}
        <View style={styles.titles}>
          <Text
            style={[large ? styles.titleLarge : styles.title, { color: colors.text }]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {actions ? (
          <View style={[styles.actionGroup, { backgroundColor: colors.secondary }]}>
            {actions}
          </View>
        ) : null}
      </View>
      {below ? <View style={styles.below}>{below}</View> : null}
    </View>
  );
}

export interface ScreenProps {
  children: React.ReactNode;
  header?: React.ReactNode;
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

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{children}</Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingBottom: 4 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 8,
    gap: 4,
  },
  headerRowLarge: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  back: { marginLeft: -4 },
  titles: { flex: 1, justifyContent: 'center', minWidth: 0 },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  titleLarge: {
    fontSize: 26,
    fontWeight: '600',
    lineHeight: 32,
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 13, marginTop: 1 },
  actionGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 2,
    height: 40,
  },
  below: { paddingHorizontal: 16, paddingTop: 8 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
    marginTop: 20,
    paddingHorizontal: 16,
  },
});
