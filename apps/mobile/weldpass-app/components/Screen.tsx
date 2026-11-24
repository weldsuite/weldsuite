/**
 * The page frame every WeldPass screen uses: safe area, a large title (tab
 * roots) or a back button with a centred title (pushed screens), and an
 * optional row of header actions.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { useI18n } from '@/lib/i18n';

export function Screen({
  title,
  back = false,
  actions,
  children,
}: Readonly<{ title: string; back?: boolean; actions?: ReactNode; children: ReactNode }>) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const router = useRouter();
  const { t } = useI18n();

  return (
    <View style={[styles.page, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      {back ? (
        <View style={styles.bar}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={12}
            style={styles.side}
          >
            <ChevronLeft size={26} color={colors.text} />
          </Pressable>
          <Text style={[styles.barTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          <View style={[styles.side, styles.sideEnd]}>{actions}</View>
        </View>
      ) : (
        <View style={styles.large}>
          <Text style={[styles.largeTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          <View style={styles.actions}>{actions}</View>
        </View>
      )}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/** A round icon button for a header. */
export function HeaderButton({
  label,
  onPress,
  children,
  testID,
}: Readonly<{ label: string; onPress: () => void; children: ReactNode; testID?: string }>) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      testID={testID}
      style={({ pressed }) => [styles.headerButton, { backgroundColor: colors.secondary, opacity: pressed ? 0.7 : 1 }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 48 },
  side: { minWidth: 72, flexDirection: 'row', alignItems: 'center' },
  sideEnd: { justifyContent: 'flex-end', gap: 8 },
  barTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  large: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  largeTitle: { flex: 1, fontSize: 30, fontWeight: '700', letterSpacing: -0.5 },
  actions: { flexDirection: 'row', gap: 8 },
  headerButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
