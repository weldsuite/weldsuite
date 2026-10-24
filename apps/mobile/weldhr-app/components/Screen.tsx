/**
 * Layout pieces every WeldHR screen uses: a tab screen with a large title and
 * pull-to-refresh, a pushed screen with a back button, and titled sections.
 */

import type { ReactNode } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { useI18n } from '@/lib/i18n';

interface ScreenProps {
  title: string;
  /** Small line above the title (the workspace name on Home). */
  eyebrow?: string;
  /** Round button(s) at the right of the title. */
  action?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** `push` shows a back button; `modal` a close button (forms). */
  variant?: 'tab' | 'push' | 'modal';
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}

export function Screen({
  title,
  eyebrow,
  action,
  refreshing = false,
  onRefresh,
  variant = 'tab',
  children,
  contentStyle,
}: Readonly<ScreenProps>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useI18n();

  const isTab = variant === 'tab';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + (isTab ? 8 : 4) }, contentStyle]}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {isTab ? null : (
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
            accessibilityRole="button"
            accessibilityLabel={variant === 'modal' ? t.common.close : t.common.back}
            testID={variant === 'modal' ? 'screen-close' : 'screen-back'}
            hitSlop={12}
            style={[styles.navButton, { backgroundColor: colors.inputBackground }]}
          >
            {variant === 'modal' ? <X size={20} color={colors.text} /> : <ChevronLeft size={22} color={colors.text} />}
          </Pressable>
        )}
        <View style={styles.titleRow}>
          <View style={styles.titleText}>
            {eyebrow ? (
              <Text style={[styles.eyebrow, { color: colors.mutedForeground }]} numberOfLines={1}>
                {eyebrow}
              </Text>
            ) : null}
            <Text style={[isTab ? styles.title : styles.pushTitle, { color: colors.text }]} accessibilityRole="header">
              {title}
            </Text>
          </View>
          {action}
        </View>
        {children}
      </ScrollView>
    </View>
  );
}

/** Round icon button for the title row ("+" on Time off and Expenses). */
export function HeaderButton({
  icon,
  label,
  onPress,
  testID,
}: Readonly<{ icon: ReactNode; label: string; onPress: () => void; testID?: string }>) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={8}
      style={({ pressed }) => [
        styles.headerButton,
        { backgroundColor: colors.inputBackground, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      {icon}
    </Pressable>
  );
}

export function Section({
  title,
  action,
  children,
  style,
}: Readonly<{ title?: string; action?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.section, style]}>
      {title ? (
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{title}</Text>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Rounded surface for grouped rows and cards. */
export function Panel({ children, style }: Readonly<{ children: ReactNode; style?: StyleProp<ViewStyle> }>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }, style]}>{children}</View>
  );
}

/** Inline error under a list; pull-to-refresh retries. */
export function ErrorNote({ message }: Readonly<{ message: string }>) {
  const { colors } = useTheme();
  return <Text style={[styles.error, { color: colors.destructive }]}>{message}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 20 },
  navButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  titleText: { flex: 1 },
  eyebrow: { fontSize: 14, fontWeight: '500', marginBottom: 2 },
  title: { fontSize: 32, fontWeight: '700', letterSpacing: -0.5 },
  pushTitle: { fontSize: 26, fontWeight: '700', letterSpacing: -0.3 },
  headerButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  section: { gap: 8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  panel: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  error: { fontSize: 13 },
});
