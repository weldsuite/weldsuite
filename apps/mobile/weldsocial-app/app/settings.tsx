import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, LogOut, Moon, Sun, Bell } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { useI18n } from '@/lib/i18n';

export default function SettingsScreen() {
  const { theme, colors, toggleTheme } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();
  const { isPermissionGranted, requestPermissions, openNotificationSettings } = useNotifications();

  const handleNotifications = async () => {
    if (isPermissionGranted) {
      await openNotificationSettings();
      return;
    }
    const granted = await requestPermissions();
    if (granted) toast.success(t.settings.pushEnabled);
    else await openNotificationSettings();
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      <View style={[styles.headerRow, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t.common.back}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t.settings.title}</Text>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.settings.account}</Text>
        <View style={[styles.row, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.label, { color: colors.text }]}>{user?.fullName || user?.email || t.settings.userFallback}</Text>
          <Text style={[styles.value, { color: colors.muted }]}>{user?.email}</Text>
        </View>
        {currentWorkspace && (
          <View style={styles.row}>
            <Text style={[styles.label, { color: colors.text }]}>{t.settings.workspace}</Text>
            <Text style={[styles.value, { color: colors.muted }]}>{currentWorkspace.name}</Text>
          </View>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.settings.preferences}</Text>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.divider }]} onPress={handleNotifications}>
          <View style={styles.rowLeft}>
            <Bell size={20} color={colors.text} />
            <Text style={[styles.label, { color: colors.text }]}>{t.settings.pushNotifications}</Text>
          </View>
          <Text style={[styles.value, { color: colors.muted }]}>{isPermissionGranted ? t.settings.on : t.settings.off}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.row} onPress={toggleTheme}>
          <View style={styles.rowLeft}>
            {theme === 'dark' ? <Moon size={20} color={colors.text} /> : <Sun size={20} color={colors.text} />}
            <Text style={[styles.label, { color: colors.text }]}>{t.settings.darkMode}</Text>
          </View>
          <Text style={[styles.value, { color: colors.muted }]}>{theme === 'dark' ? t.settings.on : t.settings.off}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={signOut}>
        <LogOut size={20} color="#EF4444" />
        <Text style={styles.signOutText}>{t.settings.signOut}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingBottom: 16 },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 28, fontWeight: '700' },
  section: { marginHorizontal: 16, marginBottom: 24, borderRadius: 12, overflow: 'hidden' },
  sectionTitle: { fontSize: 13, fontWeight: '500', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 16 },
  value: { fontSize: 15 },
  signOutButton: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, paddingVertical: 16, justifyContent: 'center' },
  signOutText: { fontSize: 16, fontWeight: '500', color: '#EF4444' },
});
