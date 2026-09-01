import { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import Constants from 'expo-constants';
import { Moon, Sun, LogOut, Bell } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import { useI18n, persistLanguage, type AppLanguage } from '@/lib/i18n';
import { useNotifications } from '@/contexts/NotificationContext';

export default function SettingsScreen() {
  const { colors, theme, toggleTheme } = useTheme();
  const { currentWorkspace } = useWorkspace();
  const { signOut } = useClerkAuth();
  const toast = useToast();
  const { t, format, language, setLanguage } = useI18n();
  const {
    isPermissionGranted,
    requestPermissions,
    openNotificationSettings,
  } = useNotifications();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  const toggleLanguage = () => {
    const next: AppLanguage = language === 'en' ? 'nl' : 'en';
    setLanguage(next);
    void persistLanguage(next);
  };

  return (
    <Screen header={<ScreenHeader title={t.settings.title} showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionCard title={t.settings.workspace}>
          <DetailRow label={t.settings.workspace} value={currentWorkspace?.name ?? t.common.dash} />
        </SectionCard>

        <SectionCard title={t.settings.appearance}>
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              {theme === 'dark' ? (
                <Moon size={18} color={colors.mutedForeground} />
              ) : (
                <Sun size={18} color={colors.mutedForeground} />
              )}
              <Text style={[styles.switchText, { color: colors.text }]}>{t.settings.darkMode}</Text>
            </View>
            <Switch value={theme === 'dark'} onValueChange={() => void toggleTheme()} />
          </View>
          <Pressable
            onPress={toggleLanguage}
            accessibilityRole="button"
            accessibilityLabel={t.settings.language}
            style={styles.languageRow}
          >
            <DetailRow label={t.settings.language} value={t.languageNames[language]} />
          </Pressable>
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.settings.languageHint}</Text>
        </SectionCard>

        <SectionCard title={t.settings.notifications}>
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Bell size={18} color={colors.mutedForeground} />
              <Text style={[styles.switchText, { color: colors.text }]}>{t.settings.enablePush}</Text>
            </View>
            <Switch
              value={isPermissionGranted}
              onValueChange={() => {
                if (isPermissionGranted) void openNotificationSettings();
                else void requestPermissions();
              }}
            />
          </View>
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.settings.pushHint}</Text>
        </SectionCard>

        <SectionCard title={t.settings.account}>
          <DetailRow label={t.settings.product} value={t.appName} />
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            {format(t.settings.version, { version: appVersion })}
          </Text>
        </SectionCard>

        <Button
          title={t.settings.signOut}
          variant="outline"
          leftIcon={<LogOut size={18} color={colors.destructive} />}
          textStyle={{ color: colors.destructive }}
          onPress={() => setConfirmSignOut(true)}
          style={styles.signOut}
        />
      </ScrollView>

      <ConfirmModal
        visible={confirmSignOut}
        title={t.settings.signOutTitle}
        message={t.settings.signOutConfirm}
        confirmText={t.settings.signOut}
        cancelText={t.common.cancel}
        variant="destructive"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={async () => {
          setConfirmSignOut(false);
          try {
            await signOut();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.settings.signOutFailed);
          }
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, paddingTop: 4 },
  hint: { fontSize: 12, marginTop: 2, marginBottom: 4 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  switchLabel: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, paddingRight: 12 },
  switchText: { fontSize: 14, fontWeight: '500' },
  languageRow: { marginTop: 4 },
  signOut: { marginHorizontal: 12, marginTop: 24 },
});
