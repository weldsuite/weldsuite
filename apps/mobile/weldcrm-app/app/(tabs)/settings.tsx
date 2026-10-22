import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { LogOut, Moon, Sun } from 'lucide-react-native';
import { APP_LANGUAGES, isAppLanguage, useI18n } from '@/lib/i18n';

export default function SettingsScreen() {
  const { theme, colors, toggleTheme } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();
  const { t, language, setLanguage } = useI18n();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]} accessibilityRole="header">
          {t.settings.title}
        </Text>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.settings.account}</Text>
        <View style={[styles.row, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.label, { color: colors.text }]}>{t.settings.name}</Text>
          <Text style={[styles.value, { color: colors.muted }]}>{user?.fullName || t.common.dash}</Text>
        </View>
        <View style={[styles.row, !currentWorkspace && styles.lastRow, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.label, { color: colors.text }]}>{t.settings.email}</Text>
          <Text style={[styles.value, { color: colors.muted }]} numberOfLines={1}>
            {user?.email || t.common.dash}
          </Text>
        </View>
        {currentWorkspace && (
          <View style={[styles.row, styles.lastRow]}>
            <Text style={[styles.label, { color: colors.text }]}>{t.settings.workspace}</Text>
            <Text style={[styles.value, { color: colors.muted }]} numberOfLines={1}>
              {currentWorkspace.name}
            </Text>
          </View>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.settings.appearance}</Text>
        <TouchableOpacity
          style={[styles.row, { borderBottomColor: colors.divider }]}
          onPress={toggleTheme}
          accessibilityRole="switch"
          accessibilityState={{ checked: theme === 'dark' }}
          accessibilityLabel={t.settings.darkMode}
        >
          <View style={styles.rowLeft}>
            {theme === 'dark' ? <Moon size={20} color={colors.text} /> : <Sun size={20} color={colors.text} />}
            <Text style={[styles.label, { color: colors.text }]}>{t.settings.darkMode}</Text>
          </View>
          <Text style={[styles.value, { color: colors.muted }]}>{theme === 'dark' ? t.settings.on : t.settings.off}</Text>
        </TouchableOpacity>
        <View style={styles.languageRow}>
          <Text style={[styles.label, { color: colors.text }]}>{t.settings.language}</Text>
          <SegmentedControl
            options={APP_LANGUAGES.map((code) => ({ value: code, label: t.languageNames[code] }))}
            value={language}
            onValueChange={(value) => {
              if (isAppLanguage(value)) setLanguage(value);
            }}
            style={styles.languagePicker}
          />
        </View>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={signOut} accessibilityRole="button">
        <LogOut size={20} color="#EF4444" />
        <Text style={styles.signOutText}>{t.settings.signOut}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  headerTitle: { fontSize: 34, fontWeight: '700' },
  section: { marginHorizontal: 16, marginBottom: 24, borderRadius: 12, overflow: 'hidden' },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  lastRow: { borderBottomWidth: 0 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 16 },
  value: { fontSize: 15, flexShrink: 1 },
  languageRow: { paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  languagePicker: { alignSelf: 'stretch' },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    paddingVertical: 16,
    justifyContent: 'center',
  },
  signOutText: { fontSize: 16, fontWeight: '500', color: '#EF4444' },
});
