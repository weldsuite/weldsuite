/**
 * Screen chrome shared by every WeldChat route.
 *
 * Matches the WeldBooks messaging-app pattern: large title on root screens,
 * compact title + back chevron on detail screens, optional pill of icon
 * actions — the same chrome as the floating bottom nav. No hairline under
 * the header; the floating pill is the primary piece of chrome.
 */

import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronDown, ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  /** Shows a back chevron. Defaults to true on any screen given an onBack. */
  onBack?: () => void;
  showBack?: boolean;
  /** Leading control (e.g. menu) rendered before the title on root screens. */
  leading?: React.ReactNode;
  /** Makes the title tappable. Shows a chevron. */
  onTitlePress?: () => void;
  titlePressAccessibilityLabel?: string;
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
  leading,
  onTitlePress,
  titlePressAccessibilityLabel,
  actions,
  below,
  style,
}: ScreenHeaderProps) {
  const { colors } = useTheme();
  const router = useRouter();
  const withBack = showBack ?? onBack !== undefined;
  const large = !withBack;

  const titleText = (
    <Text
      style={[
        large ? styles.titleLarge : styles.title,
        { color: colors.text },
        onTitlePress && styles.titleShrink,
      ]}
      numberOfLines={1}
    >
      {title}
    </Text>
  );

  const titles = (
    <>
      {onTitlePress ? (
        <Pressable
          onPress={onTitlePress}
          accessibilityRole="button"
          accessibilityLabel={titlePressAccessibilityLabel ?? title}
          hitSlop={8}
          style={({ pressed }) => [styles.titlePress, pressed && { opacity: 0.7 }]}
        >
          {titleText}
          <ChevronDown size={large ? 20 : 18} color={colors.mutedForeground} />
        </Pressable>
      ) : (
        titleText
      )}
      {subtitle ? (
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </>
  );

  return (
    <View style={[styles.header, style]}>
      <View style={[styles.headerRow, large && styles.headerRowLarge]}>
        {withBack ? (
          <IconButton
            icon={<ChevronLeft size={24} color={colors.text} />}
            accessibilityLabel="Go back"
            onPress={onBack ?? (() => router.back())}
            style={styles.back}
          />
        ) : null}
        {leading ? <View style={styles.leading}>{leading}</View> : null}
        <View style={styles.titles}>{titles}</View>
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
  /** Omit to render a screen with no header (e.g. overlays). */
  header?: React.ReactNode;
  /** Tab screens already sit inside a safe area — pass [] to skip. */
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

/** Small uppercase label that opens a group of rows. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{children}</Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    paddingBottom: 4,
  },
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
  leading: { marginLeft: -8 },
  titles: { flex: 1, justifyContent: 'center', minWidth: 0 },
  titlePress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
    alignSelf: 'flex-start',
  },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  titleLarge: {
    fontSize: 26,
    fontWeight: '600',
    lineHeight: 32,
    letterSpacing: -0.4,
  },
  titleShrink: { flexShrink: 1 },
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
